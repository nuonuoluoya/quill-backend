import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Module,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { Database } from './db.js';
import { AuthService, signedIn } from './auth.js';
import { BooksService, equal, sign } from './books.js';
import { ProgressService } from './progress.js';
import { Fault } from './errors.js';
import { Storage, byteRange } from './storage.js';
import { config, production } from './config.js';
import { contentTypes } from '../contracts/src/index.js';
import { completeContract } from './api-contract.js';
export class Services {
  auth: AuthService;
  books: BooksService;
  progress: ProgressService;
  constructor(
    public db: Database,
    public storage: Storage,
  ) {
    this.auth = new AuthService(db);
    this.books = new BooksService(db);
    this.progress = new ProgressService(db);
  }
}
const bodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: { code: { type: 'string', maxLength: 512 } },
};
@ApiTags('Pidan Vocal v1')
@ApiBearerAuth()
@Controller('v1')
class ApiController {
  constructor(@Inject(Services) private s: Services) {}
  @Post('auth/wechat')
  @ApiBody({ schema: bodySchema })
  @ApiOperation({ summary: '微信 code 换业务会话' })
  async login(@Body() body: unknown) {
    const p = z
      .object({ code: z.string().min(1).max(512) })
      .strict()
      .safeParse(body);
    if (!p.success) throw new Fault(400, 'LOGIN_CODE_INVALID', '登录凭证无效');
    return this.s.auth.login(p.data.code);
  }
  @Delete('auth/session') async logout(@Headers('authorization') h: string) {
    signedIn(await this.s.auth.identity(h));
    return this.s.auth.logout(h);
  }
  @Get('me') async me(@Headers('authorization') h?: string) {
    return { id: signedIn(await this.s.auth.identity(h)) };
  }
  @Get('books') async list(
    @Headers('authorization') h: string | undefined,
    @Query() q: Record<string, string>,
  ) {
    const parsed = z
      .object({
        audience: z.enum(['sample', 'member']).default('sample'),
        contentType: z.enum(contentTypes).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z.string().max(2048).optional(),
      })
      .strict()
      .safeParse(q);
    if (!parsed.success) throw new Fault(400, 'INVALID_REQUEST', '书架查询参数无效');
    return this.s.books.list(
      await this.s.auth.identity(h),
      parsed.data.audience,
      parsed.data.limit,
      parsed.data.cursor,
      parsed.data.contentType,
    );
  }
  @Get('books/:bookId') async book(
    @Headers('authorization') h: string | undefined,
    @Param('bookId') b: string,
  ) {
    return this.s.books.current(b, await this.s.auth.identity(h));
  }
  @Get('books/:bookId/builds/:buildId') async snapshot(
    @Headers('authorization') h: string | undefined,
    @Param() p: any,
  ) {
    return this.s.books.snapshot(p.bookId, p.buildId, await this.s.auth.identity(h));
  }
  @Get('books/:bookId/builds/:buildId/chapters/:chapterId') async chapter(
    @Headers('authorization') h: string | undefined,
    @Param() p: any,
  ) {
    return this.s.books.chapter(p.bookId, p.buildId, p.chapterId, await this.s.auth.identity(h));
  }
  @Post('books/:bookId/builds/:buildId/sentences/:sentenceId/playback') async sentencePlay(
    @Headers('authorization') h: string | undefined,
    @Param() p: any,
  ) {
    return this.s.books.playback(
      p.bookId,
      p.buildId,
      p.sentenceId,
      'sentence',
      await this.s.auth.identity(h),
    );
  }
  @Post('books/:bookId/builds/:buildId/chapters/:chapterId/playback') async chapterPlay(
    @Headers('authorization') h: string | undefined,
    @Param() p: any,
  ) {
    return this.s.books.playback(
      p.bookId,
      p.buildId,
      p.chapterId,
      'chapter',
      await this.s.auth.identity(h),
    );
  }
  @Get('me/progress/:bookId') async getProgress(
    @Headers('authorization') h: string,
    @Param('bookId') b: string,
    @Query('textRevision') r: string,
  ) {
    if (!r || r.length > 512) throw new Fault(400, 'INVALID_REQUEST', '正文版本无效');
    return this.s.progress.get(signedIn(await this.s.auth.identity(h)), b, r);
  }
  @Put('me/progress/:bookId') async put(
    @Headers('authorization') h: string,
    @Param('bookId') b: string,
    @Body() body: unknown,
  ) {
    return this.s.progress.mutate(signedIn(await this.s.auth.identity(h)), b, body);
  }
  @Post('me/progress/:bookId/reset') async reset(
    @Headers('authorization') h: string,
    @Param('bookId') b: string,
    @Body() body: unknown,
  ) {
    return this.s.progress.mutate(signedIn(await this.s.auth.identity(h)), b, body, true);
  }
  @Get('health/live') live() {
    return { status: 'ok' };
  }
  @Get('health/ready') async ready(@Headers('authorization') h: string) {
    if (production && (!process.env.READY_TOKEN || h !== `Bearer ${process.env.READY_TOKEN}`))
      throw new Fault(403, 'BOOK_FORBIDDEN', '禁止访问');
    try {
      await this.s.db.query('SELECT 1');
    } catch {
      throw new Fault(503, 'SERVICE_UNAVAILABLE', '服务未就绪');
    }
    return { status: 'ready' };
  }
}
export async function createApp(db = new Database(), storage = new Storage(), migrate = !production) {
  if (migrate) await db.migrate();
  const services = new Services(db, storage);
  @Module({ controllers: [ApiController], providers: [{ provide: Services, useValue: services }] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
  if (config.trustedProxy) app.getHttpAdapter().getInstance().set('trust proxy', config.trustedProxy);
  app.enableCors({ origin: config.corsOrigin, credentials: false });
  app.use((req: Request, res: Response, next: () => void) => {
    const start = Date.now();
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (process.env.REQUEST_LOG === '1')
      res.on('finish', () =>
        console.log(
          JSON.stringify({
            requestId: res.locals.requestId,
            method: req.method,
            route: req.route?.path || 'unmatched',
            status: res.statusCode,
            durationMs: Date.now() - start,
          }),
        ),
      );
    next();
  });
  const buckets = new Map<string, { until: number; n: number }>();
  app.use((req: Request, res: Response, next: () => void) => {
    const t = Date.now();
    for (const [k, v] of buckets) if (v.until < t) buckets.delete(k);
    if (req.path.includes('/health/')) return next();
    const category = req.path.includes('/auth/wechat')
        ? 'login'
        : req.path.startsWith('/media/')
          ? 'media'
          : 'api',
      cap = category === 'login' ? 20 : category === 'media' ? 1800 : 600;
    const key = `${req.ip}:${category}`,
      b = buckets.get(key) || { until: t + 60000, n: 0 };
    b.n++;
    buckets.set(key, b);
    if (b.n > cap) {
      res.setHeader('Retry-After', Math.ceil((b.until - t) / 1000));
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试', details: {} },
        requestId: res.locals.requestId,
      });
      return;
    }
    next();
  });
  app.use('/v1/me/progress', express.json({ limit: '4kb' }));
  app.use(express.json({ limit: '64kb' }));
  const http = app.getHttpAdapter().getInstance();
  http.all('/media/:audioId', async (req: Request, res: Response) => {
    const error = (status: number, code: string, message: string) =>
      res
        .status(status)
        .json({ error: { code, message, details: {} }, requestId: res.locals.requestId });
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return error(405, 'INVALID_REQUEST', '请求方法不支持');
      }
      const id = String(req.params.audioId),
        exp = Number(req.query.exp),
        sig = String(req.query.sig || '');
      if (
        !/^[a-f0-9]{64}$/.test(id) ||
        !Number.isSafeInteger(exp) ||
        exp <= Date.now() / 1000 ||
        !equal(sig, sign(`media:${id}:${exp}`))
      )
        return error(403, 'MEDIA_FORBIDDEN', '音频链接已失效');
      const a = (await db.query('SELECT * FROM audio_assets WHERE audio_id=$1', [id])).rows[0];
      if (!a) return error(404, 'MEDIA_NOT_FOUND', '音频不存在');
      const size = Number(a.bytes);
      if ((await storage.size(a.object_key)) !== size)
        return error(503, 'SERVICE_UNAVAILABLE', '音频暂不可用');
      const range =
        req.method === 'HEAD' ? { status: 200 as const } : byteRange(req.headers.range, size);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'audio/mpeg');
      if (range.status === 416) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      if (range.status === 400) return error(400, 'INVALID_REQUEST', '无效字节区间');
      const partial = range.status === 206;
      res.status(range.status);
      res.setHeader('Content-Length', partial ? range.end! - range.start! + 1 : size);
      if (partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      if (req.method === 'HEAD') return res.end();
      await pipeline(
        await storage.stream(
          a.object_key,
          partial ? { start: range.start!, end: range.end! } : undefined,
        ),
        res,
      );
    } catch {
      if (!res.headersSent) {
        res.removeHeader('Content-Length');
        return error(503, 'SERVICE_UNAVAILABLE', '音频读取失败');
      }
      res.destroy();
    }
  });
  // Keep middleware/parser errors in the same public envelope; never echo raw URL or stack.
  http.use((err: any, _req: Request, res: Response, _next: any) =>
    res.status(err.status === 413 ? 413 : 400).json({
      error: { code: 'INVALID_REQUEST', message: '请求体无效或过大', details: {} },
      requestId: res.locals.requestId,
    }),
  );
  app.useGlobalFilters({
    catch(error: any, host) {
      const res = host.switchToHttp().getResponse<Response>();
      const status =
        error instanceof Fault
          ? error.getStatus()
          : typeof error.getStatus === 'function'
            ? error.getStatus()
            : 500;
      res.status(status).json({
        error: {
          code:
            error instanceof Fault
              ? error.code
              : status === 404
                ? 'NOT_FOUND'
                : 'SERVICE_UNAVAILABLE',
          message: error instanceof Fault ? error.message : '服务暂不可用',
          details: error instanceof Fault ? error.details : {},
        },
        requestId: res.locals.requestId,
      });
    },
  });
  // Response envelope needs the per-request identifier, not a process global.
  app.useGlobalInterceptors({
    intercept(ctx, next) {
      const res = ctx.switchToHttp().getResponse<Response>();
      return next.handle().pipe(map((data) => ({ data, requestId: res.locals.requestId })));
    },
  });
  const document = completeContract(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Pidan Vocal API').setVersion('1.3.0').addBearerAuth().build(),
    ),
  );
  if (!production) SwaggerModule.setup('docs', app, document);
  await app.init();
  return { app, db, services, document };
}
import { map } from 'rxjs/operators';
