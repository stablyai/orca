export type WindowsNetworkCategory = 'private' | 'public' | 'domain' | 'unknown'

export type WindowsMobileFirewallStatus =
  | { supported: false }
  | {
      supported: true
      port: number
      ruleAllowed: boolean
      blockingRuleDetected: boolean
      privateFirewallEnabled: boolean
      networkCategory: WindowsNetworkCategory
      inspectionAvailable: boolean
    }

export type WindowsMobileFirewallRepairResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'failed' | 'unsupported' }
