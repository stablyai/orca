import { translate } from '@/i18n/i18n'
import {
  getCodexAccountDisplayLabel,
  normalizeCodexAccountEmail
} from './codex-account-display-label'

// Why: prompt integrations such as Starship can outlast the daemon's 300ms
// Codex fast-path timeout; account restarts must wait until the shell accepts input.
// Why launchAgent: pty:spawn runs the managed-auth readiness gate and Codex
// launch prep only for launchAgent 'codex', so without it a restart respawn
// could race the account handoff and record a launch account the pane does not
// actually read.
export const CODEX_ACCOUNT_RESTART_STARTUP = {
  command: 'codex',
  startupCommandDelivery: 'shell-ready',
  launchAgent: 'codex'
} as const

// Same-email accounts need the same workspace or ID distinction as the switcher.
export function resolveCodexSwitchAccountLabel(
  accounts: readonly { id: string; email: string; workspaceLabel?: string | null }[],
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return translate('auto.lib.codex.session.restart.4bd4a3a9c7', 'System default')
  }
  const account = accounts.find((entry) => entry.id === accountId)
  if (!account) {
    return translate('auto.lib.codex.session.restart.9f0b1c2d3e', 'Codex account')
  }
  const email = normalizeCodexAccountEmail(account.email)
  const sharesEmail = accounts.some(
    (entry) => entry.id !== account.id && normalizeCodexAccountEmail(entry.email) === email
  )
  return sharesEmail ? getCodexAccountDisplayLabel(account, accounts) : account.email
}
