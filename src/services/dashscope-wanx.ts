import createError from 'http-errors';

/** 万相 VACE video_repainting。文档：https://help.aliyun.com/zh/model-studio/wanx-vace-api-reference */
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

    const controlCondition =
      process.env.WANX_CONTROL_CONDITION ?? 'posebodyface';
    const promptExtend = process.env.WANX_PROMPT_EXTEND === 'true';

    const body = {
      model: this.model,
      input: {
        function: 'video_repainting',
        prompt,
        video_url: videoOssUrl,
        ref_images_url: [imageOssUrl],
      },
      parameters: {
        prompt_extend: promptExtend,
        control_condition: controlCondition,
      },
    };

    const res = await fetch(
      `${this.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
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
