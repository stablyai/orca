import type { SecretAtRestProtection } from './secret-at-rest-protection'

/** GLM Coding Plan sites share provider ID zcode: international Z.AI and mainland BigModel. */
export type ZcodePlanSite = 'zai' | 'bigmodel'

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
  /** Set when the saved file cannot be used here; 'sealed-elsewhere' means the other Orca app
   *  on that machine (desktop vs orcad) saved it. */
  apiKeyUnreadable?: 'sealed-elsewhere' | 'unreadable'
}
