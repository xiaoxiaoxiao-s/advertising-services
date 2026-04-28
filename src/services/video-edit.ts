import createError from 'http-errors';
import { spawnSync } from 'child_process';
import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  promises as fsp,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ReadStream } from 'fs';
import { DashscopeUploader } from './dashscope-upload';
import { DashscopeWanx } from './dashscope-wanx';

export type UploadedPart = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
};

export async function processVideoWithWanx(
  params: {
    prompt: string;
    video: UploadedPart;
    image: UploadedPart;
    /** 与视频分辨率一致：白 [255,255,255]=编辑区，黑 [0,0,0]=保留。提供时走万相 `video_edit`，否则为整段 `video_repainting`。 */
    mask?: UploadedPart;
  },
  deps?: { upload?: DashscopeUploader; wanx?: DashscopeWanx },
): Promise<ReadStream> {
  const dashUpload = deps?.upload ?? new DashscopeUploader();
  const wanx = deps?.wanx ?? new DashscopeWanx();

  assertFfmpegAvailable();

  const envChunk = Math.max(
    1,
    Math.floor(Number(process.env.VIDEO_CHUNK_SECONDS ?? '8')),
  );
  const useLocalEdit = Boolean(params.mask);
  /** 局部编辑接口单段最多处理约 5 秒，超长会被截断，故与官方一致将切片上限压到 5。 */
  const chunkSec = useLocalEdit ? Math.min(envChunk, 5) : envChunk;

  const workDir = mkdtempSync(join(tmpdir(), 'wanx-edit-'));
  const inputVideo = join(workDir, 'input.mp4');

  try {
    await fsp.writeFile(inputVideo, params.video.buffer);
    runFfmpegSegment(inputVideo, workDir, chunkSec);

    const segments = listSegmentFiles(workDir);
    if (segments.length === 0) {
      throw createError(500, '切片后没有得到任何视频分段');
    }

    const imageOss = await dashUpload.uploadBuffer(
      params.image.buffer,
      params.image.originalname || 'ref.png',
      params.image.mimetype || 'image/png',
    );

    const maskOss = params.mask
      ? await dashUpload.uploadBuffer(
          params.mask.buffer,
          params.mask.originalname || 'mask.png',
          params.mask.mimetype || 'image/png',
        )
      : undefined;

    const outputParts: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segBuf = await fsp.readFile(segments[i]!);
      const videoOss = await dashUpload.uploadBuffer(
        segBuf,
        `part-${i}.mp4`,
        'video/mp4',
      );
      const taskId =
        useLocalEdit && maskOss
          ? await wanx.createVideoEditTask(
              params.prompt,
              videoOss,
              imageOss,
              maskOss,
            )
          : await wanx.createVideoRepaintingTask(
              params.prompt,
              videoOss,
              imageOss,
            );
      const resultUrl = await wanx.waitForVideoUrl(taskId);
      const outPath = join(workDir, `out-${String(i).padStart(3, '0')}.mp4`);
      await downloadToFile(resultUrl, outPath);
      outputParts.push(outPath);
    }

    const merged = join(workDir, 'merged.mp4');
    runFfmpegConcat(outputParts, merged);

    const stream = createReadStream(merged);
    stream.on('close', () => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    return stream;
  } catch (err) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function runFfmpegSegment(
  inputPath: string,
  workDir: string,
  segmentSeconds: number,
): void {
  const pattern = join(workDir, 'seg_%03d.mp4');
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-c',
      'copy',
      '-map',
      '0',
      '-f',
      'segment',
      '-segment_time',
      String(segmentSeconds),
      '-reset_timestamps',
      '1',
      pattern,
    ],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    throw createError(
      500,
      `ffmpeg 切片失败: ${result.stderr || result.stdout || '未知错误'}`,
    );
  }
}

function runFfmpegConcat(partFiles: string[], outputPath: string): void {
  const listPath = `${outputPath}.concat.txt`;
  const listBody = partFiles
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(listPath, listBody, 'utf-8');

  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      outputPath,
    ],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    throw createError(
      500,
      `ffmpeg 合并失败: ${result.stderr || result.stdout || '未知错误'}`,
    );
  }
}

function assertFfmpegAvailable(): void {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw createError(500, '系统未安装 ffmpeg 或不在 PATH 中，请先安装 ffmpeg');
  }
}

function listSegmentFiles(workDir: string): string[] {
  const names = readdirSync(workDir)
    .filter((n) => /^seg_\d+\.mp4$/.test(n))
    .sort((a, b) => {
      const ma = a.match(/(\d+)/);
      const mb = b.match(/(\d+)/);
      const na = ma ? parseInt(ma[1]!, 10) : 0;
      const nb = mb ? parseInt(mb[1]!, 10) : 0;
      return na - nb;
    });
  return names.map((n) => join(workDir, n));
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw createError(
      500,
      `下载万相输出视频失败: HTTP ${String(res.status)}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
}
