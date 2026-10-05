import { z } from 'zod';
import { Database, type Queryable } from './db.js';
import { sha } from './auth.js';
import { readable, equal, sign } from './books.js';
import { Fault } from './errors.js';
import { playable, type FavoriteItem, type FavoritePage, type FavoriteReference, type FavoriteWriteResult, type FavoriteStatusResult, type Sentence } from '../contracts/src/index.js';
const identity = z.string().min(1).max(512);
const referenceSchema = z.object({bookId:identity,textRevision:identity,chapterId:identity,sentenceId:identity});
const mutationFields = {clientMutationId:z.string().uuid(),clientMutationCreatedAt:z.string().datetime()};
export const favoriteWriteSchema = referenceSchema.extend({sourceBuildId:identity,...mutationFields}).strict();
export const favoriteDeleteSchema = z.object(mutationFields).strict();
export const favoriteStatusSchema = z.object({bookId:identity,textRevision:identity,chapterId:identity,sourceBuildId:identity,
  sentenceIds:z.array(identity).min(1).max(200).refine(ids=>new Set(ids).size===ids.length)}).strict();
const querySchema = z.object({q:z.string().trim().max(100).default(''),limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().min(1).max(4096).optional()}).strict();
const cursorSchema = z.object({user:z.string(),q:z.string(),reviewAudio:z.boolean(),version:z.number().int().nonnegative().safe(),lastAddedVersion:z.number().int().positive().safe()}).strict();
const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const favoriteId = (r:FavoriteReference) => sha(JSON.stringify([r.bookId,r.textRevision,r.chapterId,r.sentenceId]));
function parse<S extends z.ZodTypeAny>(schema:S,value:unknown):z.output<S> {const result=schema.safeParse(value);if(!result.success)throw new Fault(400,'INVALID_REQUEST','收藏请求字段无效');return result.data;}
function assertIdentity(row:any,r:FavoriteReference) {
  if(row && (row.book_id!==r.bookId || row.text_revision!==r.textRevision || row.chapter_id!==r.chapterId || row.sentence_id!==r.sentenceId))
    throw new Fault(409,'FAVORITE_INVALID','收藏身份不一致');
}
export async function favoriteRequest<T>(work:()=>Promise<T>):Promise<T> {
  try{return await work();}catch(error){if(error instanceof Fault)throw error;throw new Fault(503,'SERVICE_UNAVAILABLE','收藏服务暂不可用，请重试');}
}

// One statement/snapshot for permissions, whole-result counts and pagination. Source metadata
// is joined only after LIMIT. Never read a manifest, media object, or all Book arrays per item.
export const favoritePageSql = `
WITH account AS (SELECT COALESCE((SELECT version FROM favorite_accounts WHERE user_id=$1),0) AS version),
resolved AS MATERIALIZED (
 SELECT f.*, b.active_build_id AS resolved_build_id,
 CASE WHEN b.book_id IS NULL THEN 'content_unavailable'
      WHEN b.visibility='private' AND a.user_id IS NULL THEN 'forbidden'
      WHEN v.build_id IS NULL THEN 'content_unavailable'
      WHEN v.text_revision<>f.text_revision THEN 'text_revision_changed'
      WHEN s.sentence_id IS NULL THEN 'content_unavailable' ELSE 'available' END AS status,
 s.content AS sentence
 FROM sentence_favorites f
 LEFT JOIN books b ON b.book_id=f.book_id
 LEFT JOIN book_access a ON a.book_id=b.book_id AND a.user_id=$1 AND a.revoked_at IS NULL
   AND a.starts_at<=now() AND (a.expires_at IS NULL OR a.expires_at>now())
 LEFT JOIN book_builds v ON v.book_id=b.book_id AND v.build_id=b.active_build_id AND v.status='active'
 LEFT JOIN sentences s ON s.book_id=f.book_id AND s.build_id=v.build_id AND s.chapter_id=f.chapter_id AND s.sentence_id=f.sentence_id
   AND v.text_revision=f.text_revision AND (b.visibility='sample-public' OR a.user_id IS NOT NULL)
 WHERE f.user_id=$1 AND ($6::text IS NULL OR f.favorite_id=$6)
), matched AS MATERIALIZED (
 SELECT *, (status='available' AND jsonb_typeof(sentence->'audioId')='string' AND length(sentence->>'audioId')>0
  AND CASE WHEN jsonb_typeof(sentence->'duration')='number' THEN (sentence->>'duration')::float8>0 AND (sentence->>'duration')::float8<'Infinity'::float8 ELSE false END
  AND (sentence->'alignment'->>'status' IN ('verified','auto_passed') OR ($3::boolean AND sentence->'alignment'->>'status'='needs_review'))) AS playable
 FROM resolved WHERE $2::text='' OR (status='available' AND strpos(lower(sentence->>'text'),lower($2))>0)
), page AS MATERIALIZED (
 SELECT * FROM matched WHERE ($4::bigint IS NULL OR added_version<$4) ORDER BY added_version DESC LIMIT $5
), detailed AS (
 SELECT p.*, CASE WHEN p.status='available' AND p.page_rank<$5 THEN jsonb_build_object(
  'bookTitle',v.metadata->>'title','chapterTitle',c.entry->>'title','contentType',COALESCE(v.metadata->>'contentType','book'),
  'seasonTitle',(SELECT x->>'title' FROM jsonb_array_elements(COALESCE(v.metadata->'seasons','[]'::jsonb)) x WHERE x->>'id'=c.entry->>'seasonId' LIMIT 1),
  'episodeTitle',(SELECT x->>'title' FROM jsonb_array_elements(COALESCE(v.metadata->'episodes','[]'::jsonb)) x WHERE x->>'id'=c.entry->>'episodeId' LIMIT 1),
  'episodeNumber',CASE WHEN v.metadata->>'contentType'='podcast' THEN (SELECT x->'number' FROM jsonb_array_elements(COALESCE(v.metadata->'episodes','[]'::jsonb)) x WHERE x->>'id'=c.entry->>'episodeId' LIMIT 1) ELSE c.entry->'episodeNumber' END,
  'part',c.entry->'part') ELSE NULL END AS source
 FROM (SELECT page.*,row_number() OVER (ORDER BY added_version DESC) AS page_rank FROM page) p LEFT JOIN book_builds v ON p.status='available' AND p.page_rank<$5 AND v.book_id=p.book_id AND v.build_id=p.resolved_build_id
 LEFT JOIN chapters c ON p.status='available' AND p.page_rank<$5 AND c.book_id=p.book_id AND c.build_id=p.resolved_build_id AND c.chapter_id=p.chapter_id
)
SELECT (SELECT version FROM account)::text AS version,
 (SELECT count(*)::int FROM resolved) AS total_count,(SELECT count(*)::int FROM matched) AS matched_count,
 (SELECT count(*)::int FROM matched WHERE playable) AS playable_count,
 COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.added_version DESC) FROM detailed d),'[]'::jsonb) AS items`;

function present(row:any,reviewAudio:boolean):FavoriteItem {
  const base={favoriteId:row.favorite_id,favoritedAt:new Date(row.favorited_at).toISOString(),status:row.status};
  if(row.status!=='available')return {...base,reference:null,resolvedBuildId:null,sentence:null,source:null,playable:false};
  const sentence:Sentence = !reviewAudio && row.sentence.alignment.status==='needs_review'
    ? {...row.sentence,audioId:null,duration:null} : row.sentence;
  return {...base,reference:{bookId:row.book_id,textRevision:row.text_revision,chapterId:row.chapter_id,sentenceId:row.sentence_id},
    resolvedBuildId:row.resolved_build_id,sentence,source:row.source,playable:playable(sentence)};
}
export class FavoritesService {
  constructor(private db:Database) {}
  async list(user:string,input:unknown,reviewAudio=false):Promise<FavoritePage> {
    const q=parse(querySchema,input);let cursor:z.infer<typeof cursorSchema>|undefined;
    if(q.cursor) {
      try {
        const [body,sig,extra]=q.cursor.split('.');
        if(!body || !sig || extra!==undefined || !equal(sig,sign('favorites:'+body)))throw Error();
        cursor=cursorSchema.parse(JSON.parse(Buffer.from(body,'base64url').toString('utf8')));
        if(cursor.user!==user || cursor.q!==q.q || cursor.reviewAudio!==reviewAudio)throw Error();
      } catch {throw new Fault(400,'INVALID_REQUEST','收藏分页无效，请刷新');}
    }
    const {rows}=await this.db.query(favoritePageSql,[user,q.q,reviewAudio,cursor?.lastAddedVersion??null,q.limit+1,null]);
    const r=rows[0],version=Number(r.version);
    if(cursor && cursor.version!==version)throw new Fault(409,'FAVORITES_CHANGED','收藏已变化，请刷新');
    const selected=r.items.slice(0,q.limit),last=selected.at(-1);let nextCursor=null;
    if(r.items.length>q.limit) {
      const body=Buffer.from(JSON.stringify({user,q:q.q,reviewAudio,version,lastAddedVersion:Number(last.added_version)})).toString('base64url');
      nextCursor=body+'.'+sign('favorites:'+body);
    }
    return {items:selected.map((row:any)=>present(row,reviewAudio)),nextCursor,version,totalCount:r.total_count,matchedCount:r.matched_count,playableCount:r.playable_count};
  }
  async get(user:string,id:string,reviewAudio=false):Promise<FavoriteItem> {
    parse(idSchema,id);
    const {rows}=await this.db.query(favoritePageSql,[user,'',reviewAudio,null,2,id]);
    if(!rows[0].items.length)throw new Fault(404,'FAVORITE_NOT_FOUND','收藏不存在');
    return present(rows[0].items[0],reviewAudio);
  }
  async status(user:string,input:unknown):Promise<FavoriteStatusResult> {
    const p=parse(favoriteStatusSchema,input);
    return this.db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const {build}=await readable(tx,p.bookId,p.sourceBuildId,user);
      if(build.text_revision!==p.textRevision)throw new Fault(422,'FAVORITE_INVALID','正文版本不匹配');
      const {rows}=await tx.query(`SELECT s.sentence_id,f.favorite_id,
        COALESCE((SELECT version FROM favorite_accounts WHERE user_id=$1),0)::text AS version
        FROM sentences s LEFT JOIN sentence_favorites f ON f.user_id=$1 AND f.book_id=s.book_id
        AND f.text_revision=$3 AND f.chapter_id=s.chapter_id AND f.sentence_id=s.sentence_id
        WHERE s.book_id=$2 AND s.build_id=$4 AND s.chapter_id=$5 AND s.sentence_id=ANY($6::text[])`,
        [user,p.bookId,p.textRevision,p.sourceBuildId,p.chapterId,p.sentenceIds]);
      if(rows.length!==p.sentenceIds.length)throw new Fault(422,'FAVORITE_INVALID','章节或句子归属不匹配');
      const found=new Map(rows.map(r=>[r.sentence_id,r]));
      return {version:Number(rows[0].version),states:p.sentenceIds.map(sentenceId=>{
        const id=favoriteId({...p,sentenceId});const saved=found.get(sentenceId)!.favorite_id;
        if(saved && saved!==id)throw new Fault(409,'FAVORITE_INVALID','收藏身份不一致');
        return {sentenceId,favoriteId:id,saved:Boolean(saved)};
      })};
    });
  }
  async put(user:string,input:unknown):Promise<FavoriteWriteResult> {
    const p=parse(favoriteWriteSchema,input);return this.mutate(user,favoriteId(p),p,'put');
  }
  async delete(user:string,id:string,input:unknown):Promise<FavoriteWriteResult> {
    parse(idSchema,id);return this.mutate(user,id,parse(favoriteDeleteSchema,input),'delete');
  }
  private async mutate(user:string,id:string,p:z.infer<typeof favoriteWriteSchema>|z.infer<typeof favoriteDeleteSchema>,method:'put'|'delete'):Promise<FavoriteWriteResult> {
    // Schema output gives a fixed field order; JSON request property order is not an idempotency change.
    const digest=sha(JSON.stringify({method,favoriteId:id,...p}));
    return this.db.transaction(async tx=>{
      const locked=await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user]);
      if(!locked.rows.length)throw new Fault(401,'SESSION_EXPIRED','请重新登录');
      await tx.query('INSERT INTO favorite_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING',[user]);
      const version=Number((await tx.query('SELECT version FROM favorite_accounts WHERE user_id=$1',[user])).rows[0].version);
      const prior=(await tx.query('SELECT digest FROM favorite_mutations WHERE user_id=$1 AND client_mutation_id=$2',[user,p.clientMutationId])).rows[0];
      let row:Record<string,any>|undefined=(await tx.query('SELECT * FROM sentence_favorites WHERE user_id=$1 AND favorite_id=$2',[user,id])).rows[0];
      if(method==='put')assertIdentity(row,p as FavoriteReference);
      const result=(v:number):FavoriteWriteResult=>({favoriteId:id,saved:Boolean(row),favoritedAt:row?new Date(row.favorited_at).toISOString():null,version:v});
      if(prior) {
        if(prior.digest!==digest)throw new Fault(409,'IDEMPOTENCY_KEY_REUSED','同一写入标识不能用于不同操作');
        return result(version);
      }
      const timestamp=Date.parse(p.clientMutationCreatedAt),now=Date.now();
      if(timestamp<now-24*60*60*1000 || timestamp>now+5*60*1000)
        throw new Fault(409,'FAVORITE_MUTATION_EXPIRED','收藏操作已过期或设备时间不正确，请先刷新');
      if(method==='put') {
        const w=p as z.infer<typeof favoriteWriteSchema>;
        // Publish/revoke also lock books before builds. Hold the pointer stable until this write commits.
        await tx.query('SELECT book_id FROM books WHERE book_id=$1 FOR SHARE',[w.bookId]);
        const {book,build}=await readable(tx,w.bookId,w.sourceBuildId,user);
        if(build.text_revision!==w.textRevision || !(await tx.query('SELECT 1 FROM sentences WHERE book_id=$1 AND build_id=$2 AND chapter_id=$3 AND sentence_id=$4',[w.bookId,w.sourceBuildId,w.chapterId,w.sentenceId])).rows.length)
          throw new Fault(422,'FAVORITE_INVALID','正文版本或句子归属不匹配');
        const active=(await tx.query("SELECT text_revision FROM book_builds WHERE book_id=$1 AND build_id=$2 AND status='active'",[w.bookId,book.active_build_id])).rows[0];
        if(!active)throw new Fault(503,'SERVICE_UNAVAILABLE','当前内容暂不可用');
        if(active.text_revision!==w.textRevision)throw new Fault(409,'FAVORITE_TEXT_REVISION_CHANGED','正文版本已改变，请重新定位句子');
        if(!row && Number((await tx.query('SELECT count(*)::int AS count FROM sentence_favorites WHERE user_id=$1',[user])).rows[0].count)>=10000)
          throw new Fault(409,'FAVORITES_LIMIT_REACHED','收藏已达到10000条上限，请先取消部分收藏');
      }
      const changed=method==='put'?!row:Boolean(row),next=version+(changed?1:0);
      if(!Number.isSafeInteger(next))throw new Fault(503,'SERVICE_UNAVAILABLE','收藏版本暂不可写入');
      if(changed) {
        if(method==='put') {
          const w=p as z.infer<typeof favoriteWriteSchema>;
          row=(await tx.query(`INSERT INTO sentence_favorites(user_id,favorite_id,book_id,text_revision,chapter_id,sentence_id,source_build_id,favorited_at,added_version)
            VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8) RETURNING *`,[user,id,w.bookId,w.textRevision,w.chapterId,w.sentenceId,w.sourceBuildId,next])).rows[0];
        } else {await tx.query('DELETE FROM sentence_favorites WHERE user_id=$1 AND favorite_id=$2',[user,id]);row=undefined;}
        await tx.query('UPDATE favorite_accounts SET version=$2 WHERE user_id=$1',[user,next]);
      }
      await tx.query('INSERT INTO favorite_mutations(user_id,client_mutation_id,digest) VALUES($1,$2,$3)',[user,p.clientMutationId,digest]);
      return result(next);
    });
  }
}