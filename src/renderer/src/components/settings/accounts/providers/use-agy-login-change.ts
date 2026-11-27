import type { AntigravityAccountState } from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { useOnLaterChange } from './use-on-later-change'

function loginKey(state: AntigravityAccountState | null): string | null {
  if (!state) {
    return null
  }
  const current = state.currentAccount
  return current
    ? [current.subject, current.email, current.expiredAt, state.activeAccountId].join('|')
    : 'signedOut'
}

/** Re-reads the rows each time the host sees agy's stored login change (a terminal sign-in, a
 *  token refresh), and calls `loginChanged` once they show another login, so errors about the
 *  previous one clear. */
export function useAgyLoginChange(
  state: AntigravityAccountState | null,
  loginRevision: number | null,
  reread: () => void,
  loginChanged: () => void
): void {
  useOnLaterChange(loginRevision === null ? null : String(loginRevision), reread)
  useOnLaterChange(loginKey(state), loginChanged)
}
