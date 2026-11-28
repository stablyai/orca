import { useEffect, useState } from 'react'
import type {
  AntigravityAccountState,
  AntigravityLoginChange
} from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { subscribeAntigravityLoginChanges } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { useOnLaterChange } from './use-on-later-change'

// Saving the current login (as a sign-in does before it starts) changes the active account, not the
// login, so it isn't part of the key.
function loginKey(state: AntigravityAccountState | null): string | null {
  if (!state) {
    return null
  }
  const current = state.currentAccount
  return current ? [current.subject, current.email, current.expiredAt].join('|') : 'signedOut'
}

function isLoginChange(result: unknown): result is AntigravityLoginChange {
  return (
    typeof result === 'object' &&
    result !== null &&
    'loginRevision' in result &&
    typeof result.loginRevision === 'number'
  )
}

/** The host's count of changes to agy's stored login while `follow`; null until the first change,
 *  and from older hosts, which don't offer it. */
function useAgyLoginRevision(owner: RuntimeClientTarget, follow: boolean): number | null {
  const [revision, setRevision] = useState<number | null>(null)
  const kind = owner.kind
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  useEffect(() => {
    if (!follow) {
      return
    }
    let closed = false
    let unsubscribe: (() => void) | null = null
    const target: RuntimeClientTarget =
      kind === 'environment' && environmentId
        ? { kind: 'environment', environmentId }
        : { kind: 'local' }
    void subscribeAntigravityLoginChanges(target, {
      onEvent: (result) => {
        if (!closed && isLoginChange(result)) {
          setRevision(result.loginRevision)
        }
      },
      // Without it the rows update on Refresh, a sign-in or a reopen, as before.
      onError: () => {},
      onClose: () => {}
    }).then(
      (subscription) => {
        if (closed) {
          subscription.unsubscribe()
        } else {
          unsubscribe = subscription.unsubscribe
        }
      },
      () => {}
    )
    return () => {
      closed = true
      unsubscribe?.()
    }
  }, [follow, kind, environmentId])
  return revision
}

/** Re-reads the rows each time the host sees agy's stored login change (a terminal sign-in, a
 *  token refresh), and calls `loginChanged` once they show another login, so errors about the
 *  previous one clear. `follow`: the rows are the host's, whose login agy's stores hold. */
export function useAgyLoginChange(
  owner: RuntimeClientTarget,
  follow: boolean,
  state: AntigravityAccountState | null,
  reread: () => void,
  loginChanged: () => void
): void {
  const loginRevision = useAgyLoginRevision(owner, follow)
  useOnLaterChange(loginRevision === null ? null : String(loginRevision), reread)
  useOnLaterChange(loginKey(state), loginChanged)
}
