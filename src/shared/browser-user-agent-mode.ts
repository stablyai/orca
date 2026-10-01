export type BrowserUserAgentMode = 'clean' | 'native'

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
      appliedMode: 'clean'
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
