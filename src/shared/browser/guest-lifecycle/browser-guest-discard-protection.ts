export const BROWSER_GUEST_PROTECTION_CHALLENGE = 'browser:guest-protection-challenge'
export const BROWSER_GUEST_PROTECTION_REPORT = 'browser:guest-protection-report'

export type BrowserGuestDiscardProtection = {
  webContentsId: number
  protection: 'discardable' | 'protected' | 'unknown' | 'gone'
  reason: 'clean' | 'edits' | 'audio' | 'frames' | 'observer' | 'gone'
}

export type BrowserGuestDiscardProtectionChange = BrowserGuestDiscardProtection & {
  browserPageId: string
}

export type BrowserGuestDiscardApi = {
  getGuestDiscardProtection: (args: {
    browserPageId: string
    webContentsId: number
  }) => Promise<BrowserGuestDiscardProtection | null>
  onGuestDiscardProtectionChanged: (
    callback: (event: BrowserGuestDiscardProtectionChange) => void
  ) => () => void
}
