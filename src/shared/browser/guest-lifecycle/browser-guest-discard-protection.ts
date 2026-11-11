export const BROWSER_GUEST_PROTECTION_CHALLENGE = 'browser:guest-protection-challenge'
export const BROWSER_GUEST_PROTECTION_REPORT = 'browser:guest-protection-report'

export type BrowserGuestDiscardProtection = {
  webContentsId: number
  protection: 'discardable' | 'protected' | 'unknown' | 'gone'
  reason:
    | 'clean'
    | 'edits'
    | 'audio'
    | 'frames'
    | 'capture'
    | 'history'
    | 'observer'
    | 'gone'
    | 'held'
    | 'debugger'
    | 'devtools'
}

export type BrowserGuestDiscardProtectionChange = BrowserGuestDiscardProtection & {
  browserPageId: string
}

export type BrowserGuestDiscardApi = {
  preparePageAttach: (args: {
    browserPageId: string
    partition: string
    url: string
  }) => Promise<string>
  reserveGuestDiscard: (args: { browserPageId: string; webContentsId: number }) => boolean
  acknowledgeGuestRemoval: (args: {
    browserPageId: string
    webContentsId: number
  }) => Promise<boolean>
  getGuestDiscardProtection: (args: {
    browserPageId: string
    webContentsId: number
  }) => Promise<BrowserGuestDiscardProtection | null>
  onGuestDiscardProtectionChanged: (
    callback: (event: BrowserGuestDiscardProtectionChange) => void
  ) => () => void
}
