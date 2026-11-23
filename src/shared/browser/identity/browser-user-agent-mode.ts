export type BrowserUserAgentMode = 'clean' | 'native'

/** Applies until the user picks a mode; Cloudflare's full-page check rejects the cleaned identity. */
export const DEFAULT_BROWSER_USER_AGENT_MODE = 'native' satisfies BrowserUserAgentMode

export type BrowserIdentityModeSnapshot =
  | {
      state: 'missing' | 'valid'
      appliedMode: BrowserUserAgentMode
      configuredMode: BrowserUserAgentMode
      explicitSelection: boolean
      migrationNoticePending: boolean
      restartRequired: boolean
    }
  | {
      state: 'corrupt' | 'future' | 'unreadable'
      appliedMode: typeof DEFAULT_BROWSER_USER_AGENT_MODE
      configuredMode: null
      explicitSelection: null
      migrationNoticePending: null
      restartRequired: false
    }

export type BrowserIdentityModeStatus = {
  identity: BrowserIdentityModeSnapshot
  migrationNotice: { degraded: boolean } | null
}

export type BrowserIdentityModeSetResult =
  | { ok: true; identity: BrowserIdentityModeSnapshot }
  | {
      ok: false
      error: {
        code:
          | 'browser_identity_reset_required'
          | 'browser_identity_write_failed'
          | 'browser_identity_backup_failed'
        message: string
      }
      identity: BrowserIdentityModeSnapshot
    }
