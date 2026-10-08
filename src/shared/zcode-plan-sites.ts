import type { SecretAtRestProtection } from './secret-at-rest-protection'

/**
 * GLM Coding Plan site table shared by the zcode credential store, the usage
 * fetcher, and the Accounts settings section. The provider id stays `zcode`;
 * the two sites are the international Z.AI console and Zhipu's mainland
 * BigModel platform.
 */
export type ZcodePlanSite = 'zai' | 'bigmodel'

export const ZCODE_PLAN_SITES: readonly ZcodePlanSite[] = ['zai', 'bigmodel']

export function isZcodePlanSite(value: unknown): value is ZcodePlanSite {
  return value === 'zai' || value === 'bigmodel'
}

export const ZCODE_PLAN_SITE_BASE_URLS: Record<ZcodePlanSite, string> = {
  zai: 'https://api.z.ai',
  bigmodel: 'https://open.bigmodel.cn'
}

export const ZCODE_PLAN_SITE_CONSOLE_URLS: Record<ZcodePlanSite, string> = {
  zai: 'https://z.ai/manage-apikey',
  bigmodel: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys'
}

export type ZcodePlanCredentialsStatus = {
  detailsUnavailable?: boolean
  apiKeyConfigured: boolean
  zcodeCliConfigured: boolean
  apiKeyProtection: SecretAtRestProtection | null
}
