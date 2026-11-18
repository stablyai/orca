export type BrowserSiteListSetResult =
  | { ok: true; hosts: string[] }
  | { ok: false; reason: 'unavailable' | 'invalid' | 'cancelled' | 'save-failed' }
