import 'dotenv/config';
import { createServer } from 'http';
import { readFile, unlink } from 'fs/promises';
import Koa from 'koa';
import Router from '@koa/router';
import { koaBody } from 'koa-body';
import createError from 'http-errors';
import { processVideoWithWanx } from './services/video-edit';

const app = new Koa();
const router = new Router();

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err: unknown) {
    if (createError.isHttpError(err)) {
      ctx.status = err.status;
      ctx.body = { message: err.message };
      return;
    }
    ctx.status = 500;
    ctx.body = {
      message: err instanceof Error ? err.message : '服务器错误',
    };
    ctx.app.emit('error', err as Error, ctx);
  }
});

app.use(
  koaBody({
    multipart: true,
    formidable: {
      maxFileSize: 512 * 1024 * 1024,
      multiples: true,
    },
  }),
);

router.post('/edit-video', async (ctx) => {
  const body = ctx.request.body as Record<string, unknown>;
  const promptRaw = body?.prompt;
  const prompt =
    typeof promptRaw === 'string' ? promptRaw.trim() : '';
  if (!prompt) {
    throw createError(400, '请提供表单字段 prompt');
  }

  const rawFiles = ctx.request.files;
  if (!rawFiles || typeof rawFiles !== 'object') {
    throw createError(400, '请使用 multipart 上传 video 与 image');
  }

  const video = takeOneFile(
    (rawFiles as Record<string, unknown>).video,
  );
  const image = takeOneFile(
    (rawFiles as Record<string, unknown>).image,
  );

  const videoPath = video && 'filepath' in video ? String(video.filepath) : '';
  const imagePath = image && 'filepath' in image ? String(image.filepath) : '';

  if (!videoPath) {
    throw createError(400, '请上传视频文件 video');
  }
  if (!imagePath) {
    throw createError(400, '请上传参考图 image');
  }

  let vBuf: Buffer;
  let iBuf: Buffer;
  try {
    [vBuf, iBuf] = await Promise.all([
      readFile(videoPath),
      readFile(imagePath),
    ]);
  } finally {
    await Promise.allSettled([
      unlink(videoPath).catch(() => {}),
      unlink(imagePath).catch(() => {}),
    ]);
  }

  const stream = await processVideoWithWanx({
    prompt,
    video: {
      buffer: vBuf,
      originalname: fileName(video, 'video.mp4'),
      mimetype: fileMime(video, 'video/mp4'),
    },
    image: {
      buffer: iBuf,
      originalname: fileName(image, 'ref.png'),
      mimetype: fileMime(image, 'image/png'),
    },
  });

  ctx.set('Content-Type', 'video/mp4');
  ctx.set(
    'Content-Disposition',
    'attachment; filename="wanx-merged.mp4"',
  );
  ctx.body = stream;
});

function takeOneFile(
  v: unknown,
):
  | {
      filepath?: string;
      originalFilename?: string | null;
      newFilename?: string | null;
      mimetype?: string | null;
    }
  | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    const first = v[0];
    if (first && typeof first === 'object') {
      return first as {
        filepath?: string;
        originalFilename?: string | null;
        mimetype?: string | null;
      };
    }
    return undefined;
  }
  if (typeof v === 'object') {
    return v as {
      filepath?: string;
      originalFilename?: string | null;
      mimetype?: string | null;
    };
  }
  return undefined;
}

function fileName(
  f: ReturnType<typeof takeOneFile>,
  fallback: string,
): string {
  const n = f?.originalFilename ?? f?.newFilename;
  if (typeof n === 'string' && n.length > 0) return n;
  return fallback;
}

function fileMime(
  f: ReturnType<typeof takeOneFile>,
  fallback: string,
): string {
  const m = f?.mimetype;
  if (typeof m === 'string' && m.length > 0) return m;
  return fallback;
}

app.use(router.routes());
app.use(router.allowedMethods());

const port = Number(process.env.PORT ?? 3000);
const server = createServer(app.callback());
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
        `端口 ${String(port)} 已被占用。可先关闭占用进程，或换端口启动，例如：\n` +
        `  PORT=3001 npm run start:dev\n` +
        `查看占用：lsof -i :${String(port)}`,
    );
    process.exit(1);
  }
  throw err;
});
server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
