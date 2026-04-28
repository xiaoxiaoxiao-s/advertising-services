import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type LogoMaskPreset = 'tl' | 'tr' | 'bl' | 'br';

export type AutoMaskOptions = {
  preset: LogoMaskPreset;
  /** 白框宽度占视频宽度百分比 */
  widthPct?: number;
  /** 白框高度占视频高度百分比 */
  heightPct?: number;
  /** 距边缘留白占对应边的百分比 */
  marginPct?: number;
};

export function probeVideoDimensions(videoPath: string): {
  width: number;
  height: number;
} {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=s=x:p=0',
      videoPath,
    ],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    throw new Error(`ffprobe 失败: ${r.stderr || r.stdout || '未知错误'}`);
  }
  const line = (r.stdout ?? '').trim().split('\n')[0] ?? '';
  const m = line.match(/^(\d+)x(\d+)$/);
  if (!m) {
    throw new Error(`无法解析视频分辨率: ${line}`);
  }
  return {
    width: parseInt(m[1]!, 10),
    height: parseInt(m[2]!, 10),
  };
}

export function probeVideoDimensionsFromBuffer(buf: Buffer): {
  width: number;
  height: number;
} {
  const dir = mkdtempSync(join(tmpdir(), 'probe-v-'));
  const p = join(dir, 'in.mp4');
  try {
    writeFileSync(p, buf);
    return probeVideoDimensions(p);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function computeMaskBox(
  width: number,
  height: number,
  opt: AutoMaskOptions,
): { x: number; y: number; w: number; h: number } {
  const widthPct = opt.widthPct ?? 18;
  const heightPct = opt.heightPct ?? 12;
  const marginPct = opt.marginPct ?? 2;
  const marginX = Math.round((width * marginPct) / 100);
  const marginY = Math.round((height * marginPct) / 100);
  let bw = Math.round((width * widthPct) / 100);
  let bh = Math.round((height * heightPct) / 100);
  bw = Math.max(8, Math.min(bw, width - 2));
  bh = Math.max(8, Math.min(bh, height - 2));
  let x = 0;
  let y = 0;
  switch (opt.preset) {
    case 'tl':
      x = marginX;
      y = marginY;
      break;
    case 'tr':
      x = width - bw - marginX;
      y = marginY;
      break;
    case 'bl':
      x = marginX;
      y = height - bh - marginY;
      break;
    case 'br':
      x = width - bw - marginX;
      y = height - bh - marginY;
      break;
    default:
      throw new Error('invalid preset');
  }
  x = Math.max(0, Math.min(x, width - bw));
  y = Math.max(0, Math.min(y, height - bh));
  return { x, y, w: bw, h: bh };
}

export function renderMaskPng(
  width: number,
  height: number,
  box: { x: number; y: number; w: number; h: number },
): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'mask-gen-'));
  const out = join(dir, 'mask.png');
  try {
    const vf = `drawbox=x=${String(box.x)}:y=${String(box.y)}:w=${String(box.w)}:h=${String(box.h)}:color=white:t=fill`;
    const r = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=black:s=${String(width)}x${String(height)},format=rgb24`,
        '-vf',
        vf,
        '-frames:v',
        '1',
        out,
      ],
      { encoding: 'utf-8' },
    );
    if (r.status !== 0) {
      throw new Error(`ffmpeg 生成 mask 失败: ${r.stderr || r.stdout || '未知错误'}`);
    }
    return readFileSync(out);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 按视频分辨率在指定角生成矩形白区（万相要求：白=编辑，黑=保留）。 */
export function generateAutoMaskPng(
  videoBuf: Buffer,
  opt: AutoMaskOptions,
): Buffer {
  const { width, height } = probeVideoDimensionsFromBuffer(videoBuf);
  const box = computeMaskBox(width, height, opt);
  return renderMaskPng(width, height, box);
}
