/** Whether Apple supports the macOS an update needs on this Mac. */
export type MacosUpgradeSupport = 'supported' | 'unsupported' | 'unknown'

/** Whether an update's macOS floor is a Ventura release (13 or 13.x), the only one with model data. */
export function isVenturaRequirement(minimumMacosVersion: unknown): boolean {
  return typeof minimumMacosVersion === 'string' && minimumMacosVersion.split('.')[0] === '13'
}
