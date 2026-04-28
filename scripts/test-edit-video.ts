/**
 * 本地测试 POST /edit-video
 *
 * 请求体：multipart，字段 prompt、video、image（与 advertising-services 一致）。
 * 上传 **mask**（与视频同分辨率，白=编辑区、黑=保留）时走万相「局部编辑」video_edit，更适合只换 Logo；
 * 不传 mask 时为整段「视频重绘」video_repainting，容易改变全片画风。
 *
 * 用法：
 *   cd advertising-services && npm run test:edit-video -- ./test.mp4 ./ref.png
 *   npm run test:edit-video -- -v ./a.mp4 -i ./b.png -m ./mask.png
 *   npm run test:edit-video -- -v ./a.mp4 -i ./b.png --auto-mask tr
 *   npm run test:edit-video -- -v ./a.mp4 -i ./b.png -p "将左上角 Logo 换成参考图"
 *   ADVERTISING_SERVICES_URL=http://127.0.0.1:3001 npm run test:edit-video -- ./a.mp4 ./b.png
 *
 * 环境变量（可选）：
 *   ADVERTISING_SERVICES_URL  服务根地址，默认 http://localhost:3000
 *   OUT                       输出 mp4 路径，默认 ./wanx-merged-test.mp4
 *   EDIT_VIDEO_TIMEOUT_MS     请求超时毫秒，默认 1200000
 *   PROMPT / EDIT_VIDEO_PROMPT  未传 -p 时的默认提示词（不设则用内置 Logo 替换文案）
 */

import { access, readFile, writeFile } from 'fs/promises';
import { basename, resolve } from 'path';

/** 与扩展侧默认一致，便于联调「仅换角标、不动其余画面」 */
const BUILTIN_DEFAULT_PROMPT =
  '任务：仅替换原视频中已有的 Logo、水印或角标，不做其它画面改动。将上述标识区域替换为参考图中的图案，位置、大小与透视尽量与原标识一致，边缘自然融合。除该标识区域外，画面中人物、背景、商品、字幕等须与原视频保持一致，不要用参考图铺满全屏或覆盖整段画面。';

const DEFAULT_BASE =
  process.env.ADVERTISING_SERVICES_URL?.replace(/\/+$/, '') ??
  'http://localhost:3000';
const DEFAULT_TIMEOUT_MS = Number(
  process.env.EDIT_VIDEO_TIMEOUT_MS ?? 1_200_000,
);

function defaultPromptFromEnv(): string {
  const fromEnv =
    process.env.PROMPT?.trim() || process.env.EDIT_VIDEO_PROMPT?.trim();
  return fromEnv || BUILTIN_DEFAULT_PROMPT;
}

function printHelp(): void {
  console.log(`test-edit-video — 调用 advertising-services POST /edit-video

用法:
  npm run test:edit-video -- <video.mp4> <参考图.png|jpg|webp>
  npm run test:edit-video -- --video <path> --image <path> [选项]

选项:
  -p, --prompt <文本>   提示词（默认：环境变量 PROMPT / EDIT_VIDEO_PROMPT，或内置 Logo 替换文案）
  -m, --mask <path>     手动上传掩码图（与视频分辨率一致）。与 --auto-mask 二选一
  --auto-mask <tl|tr|bl|br>  由服务端按画面一角自动生成矩形白区 mask（常见贴片 Logo，默认 tr）
  --mask-width-pct <n>  配合 --auto-mask：白框宽度占画面宽度 %（默认 18）
  --mask-height-pct <n> 白框高度占画面高度 %（默认 12）
  --mask-margin-pct <n> 白框距该角边距 %（默认 2）
  -u, --url <base>      服务根地址（默认 ${DEFAULT_BASE}）
  -o, --out <path>      输出文件（默认 ./wanx-merged-test.mp4 或环境变量 OUT）
  -h, --help            显示本说明

环境变量:
  ADVERTISING_SERVICES_URL 同 --url
  OUT                        同 --out
  EDIT_VIDEO_TIMEOUT_MS      超时毫秒（默认 ${String(DEFAULT_TIMEOUT_MS)}）
  PROMPT / EDIT_VIDEO_PROMPT  默认提示词

前置条件:
  先在本目录启动服务: npm run start:dev  并配置 .env（如 DASHSCOPE_API_KEY、本机 ffmpeg 等）
  若出现 fetch failed / ECONNREFUSED，说明目标地址无服务监听，请确认服务已启动且端口一致（默认 3000），或设 ADVERTISING_SERVICES_URL=http://127.0.0.1:3000
`);
}

function formatFetchErr(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts: string[] = [e.message];
  const c = (e as Error & { cause?: unknown }).cause;
  if (c instanceof Error) {
    parts.push(`原因: ${c.message}`);
    const code = (c as NodeJS.ErrnoException).code;
    if (code) parts.push(`code: ${code}`);
  } else if (c && typeof c === 'object' && 'code' in c) {
    parts.push(`code: ${String((c as { code?: string }).code)}`);
  }
  return parts.join(' ');
}

function guessVideoName(path: string): string {
  const n = basename(path);
  return /\.(mp4|mov|webm)$/i.test(n) ? n : `${n}.mp4`;
}

function guessImageName(path: string): string {
  const n = basename(path);
  return /\.(png|jpe?g|webp)$/i.test(n) ? n : `${n}.png`;
}

function mimeForImage(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function guessMaskName(path: string): string {
  const n = basename(path);
  return /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(n) ? n : `${n}.png`;
}

function log(msg: string): void {
  console.error(`[test:edit-video] ${msg}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  let videoPath: string | undefined;
  let imagePath: string | undefined;
  let maskPath: string | undefined;
  let autoMaskPreset: string | undefined;
  let maskWidthPct: string | undefined;
  let maskHeightPct: string | undefined;
  let maskMarginPct: string | undefined;
  let prompt = defaultPromptFromEnv();
  let base = DEFAULT_BASE;
  let outPath = resolve(process.cwd(), process.env.OUT ?? 'wanx-merged-test.mp4');

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--video' || a === '-v') {
      videoPath = argv[++i];
    } else if (a === '--image' || a === '-i') {
      imagePath = argv[++i];
    } else if (a === '--mask' || a === '-m') {
      maskPath = argv[++i];
    } else if (a === '--auto-mask') {
      autoMaskPreset = argv[++i];
    } else if (a === '--mask-width-pct') {
      maskWidthPct = argv[++i];
    } else if (a === '--mask-height-pct') {
      maskHeightPct = argv[++i];
    } else if (a === '--mask-margin-pct') {
      maskMarginPct = argv[++i];
    } else if (a === '--prompt' || a === '-p') {
      prompt = argv[++i] ?? '';
    } else if (a === '--url' || a === '-u') {
      base = (argv[++i] ?? DEFAULT_BASE).replace(/\/+$/, '');
    } else if (a === '--out' || a === '-o') {
      outPath = resolve(process.cwd(), argv[++i] ?? 'wanx-merged-test.mp4');
    } else if (!a.startsWith('-')) {
      if (!videoPath) videoPath = a;
      else if (!imagePath) imagePath = a;
    } else {
      log(`未知参数: ${a}，使用 --help 查看说明`);
      process.exit(1);
    }
  }

  const promptFinal = prompt.trim() || defaultPromptFromEnv();

  if (maskPath && autoMaskPreset) {
    console.error('错误: -m 与 --auto-mask 请二选一。\n');
    process.exit(1);
  }

  if (!videoPath || !imagePath) {
    console.error('错误: 请提供视频与参考图路径。\n');
    printHelp();
    process.exit(1);
  }

  const videoAbs = resolve(videoPath);
  const imageAbs = resolve(imagePath);

  await access(videoAbs).catch(() => {
    throw new Error(`找不到视频文件: ${videoAbs}`);
  });
  await access(imageAbs).catch(() => {
    throw new Error(`找不到图片文件: ${imageAbs}`);
  });

  const maskAbs = maskPath ? resolve(maskPath) : undefined;
  if (maskAbs) {
    await access(maskAbs).catch(() => {
      throw new Error(`找不到掩码文件: ${maskAbs}`);
    });
  }

  const reads: Promise<Buffer>[] = [
    readFile(videoAbs),
    readFile(imageAbs),
  ];
  if (maskAbs) reads.push(readFile(maskAbs));
  const bufs = await Promise.all(reads);
  const videoBuf = bufs[0]!;
  const imageBuf = bufs[1]!;
  const maskBuf = maskAbs ? bufs[2]! : undefined;

  const form = new FormData();
  form.set('prompt', promptFinal);
  form.set(
    'video',
    new Blob([videoBuf], { type: 'video/mp4' }),
    guessVideoName(videoAbs),
  );
  form.set(
    'image',
    new Blob([imageBuf], { type: mimeForImage(imageAbs) }),
    guessImageName(imageAbs),
  );
  if (maskBuf !== undefined && maskAbs) {
    form.set(
      'mask',
      new Blob([maskBuf], { type: mimeForImage(maskAbs) }),
      guessMaskName(maskAbs),
    );
  }

  if (autoMaskPreset) {
    const s = autoMaskPreset.trim().toLowerCase();
    if (!['tl', 'tr', 'bl', 'br'].includes(s)) {
      console.error('--auto-mask 须为 tl、tr、bl、br 之一');
      process.exit(1);
    }
    form.set('mask_preset', s);
    if (maskWidthPct) form.set('mask_width_pct', maskWidthPct);
    if (maskHeightPct) form.set('mask_height_pct', maskHeightPct);
    if (maskMarginPct) form.set('mask_margin_pct', maskMarginPct);
  }

  const url = `${base}/edit-video`;
  log(`POST ${url}`);
  log(`video: ${videoAbs} (${String(videoBuf.length)} bytes)`);
  log(`image: ${imageAbs} (${String(imageBuf.length)} bytes)`);
  if (maskAbs) log(`mask: ${maskAbs} (${String(maskBuf!.length)} bytes) — 局部编辑 video_edit`);
  else if (autoMaskPreset)
    log(
      `mask: 自动生成 (${autoMaskPreset.trim()}) — 局部编辑 video_edit；Logo 若不在该角请改 preset 或改用 -m`,
    );
  else log(`mask: (未传) — 整段重绘 video_repainting，画面可能整体变化`);
  log(`prompt: ${promptFinal.slice(0, 120)}${promptFinal.length > 120 ? '…' : ''}`);
  log(`timeout: ${String(DEFAULT_TIMEOUT_MS)} ms`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === 'AbortError') {
      log(`请求超时（${String(DEFAULT_TIMEOUT_MS)} ms）`);
      process.exit(1);
    }
    log(`请求失败: ${formatFetchErr(e)}`);
    log(
      '若含 ECONNREFUSED / fetch failed：请先在本机启动 API（如 npm run start:dev），或检查 ADVERTISING_SERVICES_URL 与端口',
    );
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  const ct = res.headers.get('content-type') ?? '';

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      if (ct.includes('application/json')) {
        const j = (await res.json()) as { message?: string };
        if (typeof j.message === 'string') msg = j.message;
      } else {
        const t = await res.text();
        if (t) msg = t.slice(0, 2000);
      }
    } catch {
      /* ignore */
    }
    log(`失败: ${msg}`);
    process.exit(1);
  }

  if (!ct.includes('video') && !ct.includes('octet-stream')) {
    log(`警告: Content-Type 非视频 (${ct})，仍写入文件`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buf);
  console.log(outPath);
  log(`完成: ${outPath} (${String(buf.length)} bytes)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? formatFetchErr(e) : String(e));
  process.exit(1);
});
