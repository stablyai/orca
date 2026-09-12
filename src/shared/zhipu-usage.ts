export const ZHIPU_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'
export const ZHIPU_ALLOWED_USAGE_HOSTS = ['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn']

const ZHIPU_ALLOWED_USAGE_HOST_SET = new Set(ZHIPU_ALLOWED_USAGE_HOSTS)

export function isZhipuUsageHost(host: string): boolean {
  return ZHIPU_ALLOWED_USAGE_HOST_SET.has(host.toLowerCase())
}

export function normalizeZhipuBaseUrl(baseUrl: string | null | undefined): string {
  return baseUrl?.trim().replace(/\/+$/, '') || ZHIPU_DEFAULT_BASE_URL
}
