import { describe, expect, it } from 'vitest'
import { shouldUseShellReadyStartupDelivery } from '../../../shared/codex-startup-delivery'
import {
  CODEX_ACCOUNT_RESTART_STARTUP,
  resolveCodexSwitchAccountLabel
} from './codex-session-restart'

describe('CODEX_ACCOUNT_RESTART_STARTUP', () => {
  it('waits for shell readiness before relaunching Codex after an account switch', () => {
    // Why launchAgent is load-bearing: pty:spawn runs the managed-auth
    // readiness gate and Codex launch prep only for launchAgent 'codex', so
    // dropping it would let a restart respawn race the account handoff and
    // record a launch account the pane does not actually read.
    expect(CODEX_ACCOUNT_RESTART_STARTUP).toEqual({
      command: 'codex',
      startupCommandDelivery: 'shell-ready',
      launchAgent: 'codex'
    })
    expect(shouldUseShellReadyStartupDelivery(CODEX_ACCOUNT_RESTART_STARTUP)).toBe(true)
  })
})

describe('resolveCodexSwitchAccountLabel', () => {
  const accounts = [
    { id: 'acct-a', email: 'account-a@example.com' },
    { id: 'acct-b', email: 'account-b@example.com', workspaceLabel: 'Team' },
    { id: 'acct-c', email: 'account-b@example.com', workspaceLabel: 'Personal' }
  ]

  it('names System default, a unique email, and same-email accounts by workspace', () => {
    expect(resolveCodexSwitchAccountLabel(accounts, null)).toBe('System default')
    expect(resolveCodexSwitchAccountLabel(accounts, 'acct-a')).toBe('account-a@example.com')
    expect(resolveCodexSwitchAccountLabel(accounts, 'acct-b')).toContain('Team')
    expect(resolveCodexSwitchAccountLabel(accounts, 'missing')).toBe('Codex account')
  })
})
