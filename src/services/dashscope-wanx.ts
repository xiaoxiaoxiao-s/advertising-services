import createError from 'http-errors';

/**
 * 与 `ref_images_url` 等长；须放在 `parameters` 中。
 * 可用 `WANX_OBJ_OR_BG`（逗号分隔 obj/bg）；默认每张图为 `obj`。
 */
function objOrBgForRefCount(count: number): string[] {
  const raw = process.env.WANX_OBJ_OR_BG?.trim();
  if (raw) {
    const parts = raw.split(',').map((s) => s.trim().toLowerCase());
    const out: string[] = [];
    for (const p of parts) {
      if (p === 'obj' || p === 'bg') {
        out.push(p);
      } else {
        throw createError(
          500,
          `WANX_OBJ_OR_BG 含非法项 "${p}"，仅允许 obj 或 bg`,
        );
      }
    }
    if (out.length !== count) {
      throw createError(
        500,
        `WANX_OBJ_OR_BG 共 ${String(out.length)} 项，与参考图数量 ${String(count)} 不一致`,
      );
    }
    return out;
  }
  return Array.from({ length: count }, () => 'obj');
}

function parseStrength01(): number {
  const raw = process.env.WANX_STRENGTH?.trim();
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw createError(500, 'WANX_STRENGTH 须为 [0,1] 内的数字');
  }
  return Math.min(1, Math.max(0, n));
}

/**
 * 万相 VACE：`video_repainting` 为整段语义重绘；`video_edit` 为局部编辑（需 mask）。
 * 文档：https://help.aliyun.com/zh/model-studio/wanx-vace-api-reference
 */
export class DashscopeWanx {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    this.baseUrl =
      process.env.DASHSCOPE_BASE ?? 'https://dashscope.aliyuncs.com';
    this.apiKey = process.env.DASHSCOPE_API_KEY ?? '';
    this.model = process.env.WANX_MODEL ?? 'wanx2.1-vace-plus';
  }

  async createVideoRepaintingTask(
    prompt: string,
    videoOssUrl: string,
    imageOssUrl: string,
  ): Promise<string> {
    if (!this.apiKey) {
      throw createError(500, '缺少环境变量 DASHSCOPE_API_KEY');
    }

    const promptExtend = process.env.WANX_PROMPT_EXTEND === 'true';
    const controlCondition =
      process.env.WANX_CONTROL_CONDITION ?? 'posebodyface';
    const refImagesUrl = [imageOssUrl];

    const body = {
      model: this.model,
      input: {
        function: 'video_repainting',
        prompt,
        video_url: videoOssUrl,
        ref_images_url: refImagesUrl,
      },
      parameters: {
        prompt_extend: promptExtend,
        control_condition: controlCondition,
        strength: parseStrength01(),
        obj_or_bg: objOrBgForRefCount(refImagesUrl.length),
      },
    };

    return postAsyncWanxTask(this.baseUrl, this.apiKey, body);
  }

  /**
   * 局部编辑（`video_edit`）：`mask` 白区为编辑区、黑区保留；参考图可选用于替换内容。
   * 单段输入须 ≤5s（由上游切片保证）。
   */
  async createVideoEditTask(
    prompt: string,
    videoOssUrl: string,
    imageOssUrl: string,
    maskOssUrl: string,
  ): Promise<string> {
    if (!this.apiKey) {
      throw createError(500, '缺少环境变量 DASHSCOPE_API_KEY');
    }

    const promptExtend = process.env.WANX_PROMPT_EXTEND === 'true';
    const rawType = (process.env.WANX_MASK_TYPE ?? 'fixed').trim().toLowerCase();
    if (rawType !== 'tracking' && rawType !== 'fixed') {
      throw createError(500, 'WANX_MASK_TYPE 须为 fixed（固定角标）或 tracking（随物体运动）');
    }
    const maskType = rawType as 'fixed' | 'tracking';

    const maskFrameRaw = process.env.WANX_MASK_FRAME_ID?.trim();
    const maskFrameId =
      maskFrameRaw !== undefined && maskFrameRaw !== ''
        ? Math.max(1, Math.floor(Number(maskFrameRaw)))
        : 1;
    if (Number.isNaN(maskFrameId)) {
      throw createError(500, 'WANX_MASK_FRAME_ID 须为正整数');
    }

    const refImagesUrl = [imageOssUrl];
    /** 与 `ref_images_url`（当前恒为 1 张）等长；不读 WANX_OBJ_OR_BG，避免与其它能力混配。 */
    const objOrBg: string[] =
      process.env.WANX_VIDEO_EDIT_REF_BG === 'true' ? ['bg'] : ['obj'];

    const parameters: Record<string, unknown> = {
      prompt_extend: promptExtend,
      mask_type: maskType,
      obj_or_bg: objOrBg,
    };
    if (maskType === 'tracking') {
      parameters.expand_ratio = Number(process.env.WANX_EXPAND_RATIO ?? '0.05');
      const em = process.env.WANX_EXPAND_MODE?.trim();
      if (em) parameters.expand_mode = em;
    }
    const veCc = process.env.WANX_VIDEO_EDIT_CONTROL_CONDITION?.trim();
    if (veCc) parameters.control_condition = veCc;

    const body = {
      model: this.model,
      input: {
        function: 'video_edit',
        prompt,
        video_url: videoOssUrl,
        mask_image_url: maskOssUrl,
        mask_frame_id: maskFrameId,
        ref_images_url: refImagesUrl,
      },
      parameters,
    };

    return postAsyncWanxTask(this.baseUrl, this.apiKey, body);
  }

  async waitForVideoUrl(taskId: string): Promise<string> {
    if (!this.apiKey) {
      throw createError(500, '缺少环境变量 DASHSCOPE_API_KEY');
    }

    const intervalMs = Number(process.env.WANX_POLL_INTERVAL_MS ?? 15000);
    const maxMs = Number(process.env.WANX_POLL_MAX_MS ?? 900000);
    const deadline = Date.now() + maxMs;

    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const json: unknown = await res.json();
      const out = readOutput(json);
      const status = out?.task_status;

      if (status === 'SUCCEEDED') {
        const url = out?.video_url;
        if (typeof url === 'string' && url) return url;
        throw createError(
          500,
          `任务成功但无 video_url: ${JSON.stringify(json)}`,
        );
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        throw createError(
          500,
          `万相任务结束异常 (${String(status)}): ${JSON.stringify(out)}`,
        );
      }
      await sleep(intervalMs);
    }
    throw createError(500, `等待任务 ${taskId} 超时 (${String(maxMs)}ms)`);
  }
}

async function postAsyncWanxTask(
  baseUrl: string,
  apiKey: string,
  body: object,
): Promise<string> {
  const res = await fetch(
    `${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        'X-DashScope-OssResourceResolve': 'enable',
      },
      body: JSON.stringify(body),
    },
  );

  const json: unknown = await res.json();
  if (!res.ok) {
    throw createError(500, `创建万相任务失败: ${JSON.stringify(json)}`);
  }

  const taskId = readTaskId(json);
  if (!taskId) {
    throw createError(500, `未返回 task_id: ${JSON.stringify(json)}`);
  }
  return taskId;
}

function readTaskId(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const out = (json as { output?: { task_id?: string } }).output;
  return typeof out?.task_id === 'string' ? out.task_id : undefined;
}

function readOutput(json: unknown): Record<string, unknown> | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const out = (json as { output?: Record<string, unknown> }).output;
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
