import type { OpenAPIObject } from '@nestjs/swagger';
const string = { type: 'string' },
  integer = { type: 'integer', minimum: 0 },
  nullableString = { type: 'string', nullable: true },
  nullableNumber = { type: 'number', nullable: true };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, any>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const array = (items: any) => ({ type: 'array', items });
const speed = { type: 'number', enum: [0.75, 1, 1.25, 1.5] };
const identity = { type: 'string', minLength: 1, maxLength: 512 };
const base = {
  textRevision: identity,
  expectedVersion: { ...integer, maximum: Number.MAX_SAFE_INTEGER - 1 },
  clientMutationId: { type: 'string', format: 'uuid' },
};
const book = {
  bookId: string,
  buildId: string,
  textRevision: string,
  title: string,
  language: string,
  edition: string,
  contentScope: { type: 'string', enum: ['sample', 'complete'] },
  visibility: { type: 'string', enum: ['sample-public', 'private'] },
};
export function completeContract(document: OpenAPIObject): OpenAPIObject {
  const schemas: Record<string, any> = {
    Session: object({
      accessToken: string,
      expiresAt: { type: 'string', format: 'date-time' },
      user: object({ id: string }),
    }),
    Book: object({ ...book, chapters: array(ref('ChapterEntry')) }),
    ChapterEntry: object({
      id: string,
      title: string,
      sentenceCount: integer,
      playableCount: integer,
      duration: { type: 'number' },
      chapterAudioStatus: { type: 'string', enum: ['available', 'unavailable'] },
    }),
    BookSummary: object({
      ...book,
      chapterCount: integer,
      contentChapterCount: integer,
      sentenceCount: integer,
      playableCount: integer,
      chapterAudioAvailableCount: integer,
    }),
    BookPage: object({ items: array(ref('BookSummary')), nextCursor: nullableString }),
    AudioInfo: object({
      status: { type: 'string', enum: ['available', 'unavailable'] },
      audioId: nullableString,
      duration: nullableNumber,
      reasons: array(string),
    }),
    Alignment: object({
      status: {
        type: 'string',
        enum: ['auto_passed', 'verified', 'needs_review', 'unmatched', 'excluded'],
      },
      reasons: array(string),
    }),
    Sentence: object(
      {
        id: string,
        index: { type: 'integer', minimum: 1 },
        text: string,
        sourceText: string,
        duration: nullableNumber,
        audioId: nullableString,
        alignment: ref('Alignment'),
      },
      ['id', 'index', 'text', 'duration', 'audioId', 'alignment'],
    ),
    Chapter: object({
      bookId: string,
      buildId: string,
      textRevision: string,
      chapterId: string,
      chapterDuration: { type: 'number', minimum: 0 },
      chapterAudio: ref('AudioInfo'),
      sentences: array(ref('Sentence')),
    }),
    Playback: object({
      audioId: string,
      url: { type: 'string', format: 'uri' },
      issuedAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
      duration: { type: 'number', minimum: 0, exclusiveMinimum: true },
    }),
    Progress: object({
      bookId: string,
      textRevision: string,
      sourceBuildId: string,
      chapterId: string,
      sentenceId: string,
      preferredSpeed: speed,
      updatedAt: { type: 'string', format: 'date-time' },
    }),
    ProgressWrite: object({
      ...base,
      sourceBuildId: identity,
      chapterId: identity,
      sentenceId: identity,
      preferredSpeed: speed,
    }),
    ProgressReset: object(base),
    ProgressResult: object({ version: integer, progress: { oneOf:[ref('Progress'),{type:'object',nullable:true,enum:[null]}] } }),
    ApiError: object({
      error: object({
        code: string,
        message: string,
        details: { type: 'object', additionalProperties: true },
      }),
      requestId: string,
    }),
    Me: object({ id: string }),
    Revoked: object({ revoked: { type: 'boolean' } }),
    Health: object({ status: string }),
  };
  document.components = { ...document.components, schemas };
  document.components.securitySchemes={...document.components.securitySchemes,ready:{type:'http',scheme:'bearer',description:'Production readiness token; separate from user sessions'}};
  const response = (name: string) => ({
    description: 'Success',
    content: { 'application/json': { schema: object({ data: ref(name), requestId: string }) } },
  });
  for (const [path, item] of Object.entries(document.paths))
    for (const [method, op] of Object.entries(item)) {
      if (!op || !['get', 'post', 'put', 'delete'].includes(method)) continue;
      const route = op as any;
      const name = path.endsWith('/auth/wechat')
        ? 'Session'
        : path.endsWith('/auth/session')
          ? 'Revoked'
          : path === '/v1/me'
            ? 'Me'
            : path.includes('/health/')
              ? 'Health'
              : path.includes('/me/progress/')
                ? 'ProgressResult'
                : path.endsWith('/playback')
                  ? 'Playback'
                  : path.includes('/chapters/')
                    ? 'Chapter'
                    : path === '/v1/books'
                      ? 'BookPage'
                      : 'Book';
      route.responses = { [method === 'post' ? 201 : 200]: response(name) };
      for (const status of [400, 401, 403, 404, 409, 410, 413, 422, 429, 503])
        route.responses[status] = {
          description: 'Business error (409 PROGRESS_CONFLICT details contains ProgressResult)',
          content: { 'application/json': { schema: ref('ApiError') } },
        };
      if (path.includes('/me/progress/') && method !== 'get')
        route.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: ref(method === 'put' ? 'ProgressWrite' : 'ProgressReset'),
            },
          },
        };
      route.parameters = (path.match(/\{[^}]+\}/g) || []).map((p) => ({
        name: p.slice(1, -1),
        in: 'path',
        required: true,
        schema: string,
      }));
      if (path === '/v1/books')
        route.parameters.push(
          {
            name: 'audience',
            in: 'query',
            schema: { type: 'string', enum: ['sample', 'member'], default: 'sample' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
          { name: 'cursor', in: 'query', schema: string },
        );
      if (path.includes('/me/progress/') && method === 'get')
        route.parameters.push({
          name: 'textRevision',
          in: 'query',
          required: true,
          schema: identity,
        });
      if (path.endsWith('/health/ready')) route.security=[{ready:[]}];
      else if (path.includes('/health/') || path === '/v1/auth/wechat') route.security = [];
      else if (!path.includes('/me') && !path.includes('/auth/session'))
        route.security = [{ bearer: [] }, {}];
    }
  document.paths['/media/{audioId}'] = {};
  for (const method of ['get', 'head'] as const)
    document.paths['/media/{audioId}'][method] = {
      summary: 'Private MP3; signature verified on every request, HEAD ignores Range',
      security: [],
      parameters: [
        { name: 'audioId', in: 'path', required: true, schema: string },
        { name: 'exp', in: 'query', required: true, schema: integer },
        { name: 'sig', in: 'query', required: true, schema: string },
        { name: 'Range', in: 'header', schema: string },
      ],
      responses: {
        200: {
          description: 'Full MP3 / HEAD metadata',
          content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } },
        },
        206: { description: 'Single byte range' },
        400: { description: 'Malformed Range' },
        403: { description: 'Invalid/expired signature' },
        416: { description: 'Unsatisfiable range; Content-Range: bytes */size' },
        503: { description: 'Media temporarily unavailable' },
      },
    };
  return document;
}
