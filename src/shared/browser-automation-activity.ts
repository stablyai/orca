export const BROWSER_AUTOMATION_ACTIVITY_CHANNEL = 'browser:automationActivity'
export const BROWSER_AUTOMATION_ACTIVITY_LEASE_MS = 30_000
export const BROWSER_AUTOMATION_ACTIVITY_RENEW_MS = 10_000

export type BrowserAutomationActivityEvent = {
  browserPageId: string
  token: string
  active: boolean
  expiresAt: number
}
