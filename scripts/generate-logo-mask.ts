/**
 * 根据视频分辨率生成角标区域 mask（黑底白框，与万相 video_edit 要求一致）。
 *
 * 用法:
 *   npm run generate:mask -- ./test.mp4 -o ./logo-mask.png
 *   npm run generate:mask -- ./a.mp4 --preset br --width-pct 20 --height-pct 14 --margin-pct 2
 */

import { access, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  computeMaskBox,
  generateAutoMaskPng,
  probeVideoDimensionsFromBuffer,
  type LogoMaskPreset,
} from '../src/services/logo-mask';

function printHelp(): void {
  console.log(`generate-logo-mask — 从视频尺寸生成角标 mask PNG

用法:
  npm run generate:mask -- <video.mp4> [-o mask.png]

选项:
  --preset <tl|tr|bl|br>   白框落在哪一角（默认 tr，常见网页/贴片 Logo）
  --width-pct <0-100>      白框宽度占画面宽度比例（默认 18）
  --height-pct <0-100>     白框高度占画面高度比例（默认 12）
  --margin-pct <0-100>     白框距该角两边的留白比例（默认 2）
  -h, --help               本说明

说明:
  若 Logo 不在预设角，请用图像软件微调白框位置，或后续扩展「像素坐标」参数。
`);
}

function parsePreset(s: string | undefined): LogoMaskPreset {
  const v = (s ?? 'tr').trim().toLowerCase();
  if (v === 'tl' || v === 'tr' || v === 'bl' || v === 'br') return v;
  console.error(`错误: --preset 须为 tl、tr、bl、br`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  let videoArg: string | undefined;
  let outPath = resolve(process.cwd(), 'logo-mask.png');
  let preset: LogoMaskPreset = 'tr';
  let widthPct: number | undefined;
  let heightPct: number | undefined;
  let marginPct: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-o' || a === '--out') {
      outPath = resolve(process.cwd(), argv[++i] ?? 'logo-mask.png');
    } else if (a === '--preset') {
      preset = parsePreset(argv[++i]);
    } else if (a === '--width-pct') {
      widthPct = Number(argv[++i]);
    } else if (a === '--height-pct') {
      heightPct = Number(argv[++i]);
    } else if (a === '--margin-pct') {
      marginPct = Number(argv[++i]);
    } else if (!a.startsWith('-')) {
      videoArg = a;
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    }
  }

  if (!videoArg) {
    console.error('请提供视频路径\n');
    printHelp();
    process.exit(1);
  }

  const videoAbs = resolve(videoArg);
  await access(videoAbs).catch(() => {
    throw new Error(`找不到文件: ${videoAbs}`);
  });

  const videoBuf = await readFile(videoAbs);
  const buf = generateAutoMaskPng(videoBuf, {
    preset,
    widthPct,
    heightPct,
    marginPct,
  });

  await writeFile(outPath, buf);

  const { width, height } = probeVideoDimensionsFromBuffer(videoBuf);
  const box = computeMaskBox(width, height, {
    preset,
    widthPct,
    heightPct,
    marginPct,
  });
  console.error(
    `[generate:mask] ${String(width)}x${String(height)} 白框: x=${String(box.x)} y=${String(box.y)} w=${String(box.w)} h=${String(box.h)}`,
  );
  console.log(outPath);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
