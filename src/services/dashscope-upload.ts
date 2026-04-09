import createError from 'http-errors';
import * as crypto from 'crypto';

/** 百炼临时空间上传。文档：https://help.aliyun.com/zh/model-studio/get-temporary-file-url */
export class DashscopeUploader {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    this.baseUrl =
      process.env.DASHSCOPE_BASE ?? 'https://dashscope.aliyuncs.com';
    this.apiKey = process.env.DASHSCOPE_API_KEY ?? '';
    this.model = process.env.WANX_MODEL ?? 'wanx2.1-vace-plus';
  }

  /** 返回 oss:// 形式的 resource id */
  async uploadBuffer(
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<string> {
    if (!this.apiKey) {
      throw createError(500, '缺少环境变量 DASHSCOPE_API_KEY');
    }

    const policyRes = await fetch(
      `${this.baseUrl}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(this.model)}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const policyJson: unknown = await policyRes.json();

    if (!policyRes.ok) {
      throw createError(500, `getPolicy 失败: ${JSON.stringify(policyJson)}`);
    }

    const data = extractPolicyData(policyJson);
    const uploadDir = data.upload_dir as string;
    const key = `${uploadDir}/${crypto.randomUUID()}-${sanitizeFilename(filename)}`;

    const form = new FormData();
    form.append('OSSAccessKeyId', String(data.oss_access_key_id));
    form.append('Signature', String(data.signature));
    form.append('policy', String(data.policy));
    form.append('key', key);
    if (data.x_oss_object_acl != null) {
      form.append('x-oss-object-acl', String(data.x_oss_object_acl));
    }
    if (data.x_oss_forbid_overwrite != null) {
      form.append('x-oss-forbid-overwrite', String(data.x_oss_forbid_overwrite));
    }
    form.append('success_action_status', '200');
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: mimeType || undefined }),
      filename,
    );

    const uploadRes = await fetch(String(data.upload_host), {
      method: 'POST',
      body: form,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw createError(
        500,
        `上传到临时 OSS 失败: HTTP ${String(uploadRes.status)} ${text}`,
      );
    }

    return `oss://${key}`;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 180) || 'file.bin';
}

function extractPolicyData(policyJson: unknown): Record<string, unknown> {
  if (typeof policyJson !== 'object' || policyJson === null) {
    throw createError(500, 'getPolicy 响应异常');
  }
  const root = policyJson as Record<string, unknown>;
  const data = (root.data as Record<string, unknown>) ?? root;
  const need = [
    'upload_dir',
    'upload_host',
    'policy',
    'signature',
    'oss_access_key_id',
  ] as const;
  for (const k of need) {
    if (data[k] == null || data[k] === '') {
      throw createError(
        500,
        `getPolicy 缺少字段 ${k}: ${JSON.stringify(policyJson)}`,
      );
    }
  }
  return data;
}
