export const DEFAULT_DYNAMIC_ACCOUNT_MARGIN_PERCENT = 5
export const MAX_DYNAMIC_ACCOUNT_MARGIN_PERCENT = 50

export type DynamicAccountLaunchSettings = {
  claudeDynamicAccountLaunch?: boolean
  codexDynamicAccountLaunch?: boolean
  /** Percent an account must keep left in every usage window to be picked; shared by both providers. */
  dynamicAccountMarginPercent?: number
}

export function dynamicAccountMarginPercent(settings: DynamicAccountLaunchSettings): number {
  const value = settings.dynamicAccountMarginPercent
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DYNAMIC_ACCOUNT_MARGIN_PERCENT
  }
  return Math.min(MAX_DYNAMIC_ACCOUNT_MARGIN_PERCENT, Math.max(0, Math.round(value)))
}
