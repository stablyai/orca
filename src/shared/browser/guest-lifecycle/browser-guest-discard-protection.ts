import type { BrowserLoadStallEvent } from './browser-guest-events'
export const BROWSER_GUEST_PROTECTION_CHALLENGE = 'browser:guest-protection-challenge'
export const BROWSER_GUEST_PROTECTION_REPORT = 'browser:guest-protection-report'

export type BrowserGuestDiscardProtection = {
  webContentsId: number
  protection: 'discardable' | 'protected' | 'unknown' | 'gone'
  reason:
    | 'clean'
    | 'edits'
    | 'post'
    | 'audio'
    | 'frames'
    | 'capture'
    | 'observer'
    | 'gone'
    | 'held'
    | 'debugger'
    | 'devtools'
    | 'picture-in-picture'
    | 'pdf'
    | 'url'
    | 'notifications'
    | 'background-activity'
}

export type BrowserGuestDiscardProtectionChange = BrowserGuestDiscardProtection & {
  browserPageId: string
}

export type BrowserGuestDiscardApi = {
  reportGuestVisibility: (report: BrowserGuestVisibilityReport) => void
  onGuestIdleDiscardDue: (callback: (request: BrowserGuestIdleDiscardRequest) => void) => () => void
  refuseGuestIdleDiscard: (request: BrowserGuestIdleDiscardRequest) => void
  preparePageAttach: (args: {
    browserPageId: string
    partition: string
    url: string
  }) => Promise<string>
  reserveGuestDiscard: (args: {
    browserPageId: string
    webContentsId: number
    policyToken?: BrowserGuestIdleDiscardToken
  }) => boolean
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
  /** A page load that hasn't committed after a few seconds, and when it clears. */
  onLoadStall: (callback: (event: BrowserLoadStallEvent) => void) => () => void
}

export type BrowserGuestIdleDiscardToken = {
  rendererId: number
  generation: number
}
export type BrowserGuestVisibilityReport = {
  browserPageId: string
  webContentsId: number
  generation: number
  visible: boolean | null
}
export type BrowserGuestIdleDiscardRequest = BrowserGuestVisibilityReport & {
  policyToken: BrowserGuestIdleDiscardToken
}
