import { useEffect, useState } from 'react'
import type { AntigravityAccountState } from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { agyLoginRevisions } from '@/runtime/provider-accounts/sign-in/agy-login-revision-store'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'
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

function documentShown(): boolean {
  return (
    typeof document === 'undefined' ||
    document.visibilityState === 'visible' ||
    isDocumentVisibilityProvenStale()
  )
}

/** Whether the window is shown. macOS can leave the document reporting hidden after display
 *  sleep; input then proves it shown. */
function useWindowShown(follow: boolean): boolean {
  const [visible, setVisible] = useState(documentShown)
  useEffect(() => {
    if (!follow) {
      return
    }
    let before = documentShown()
    const update = () => {
      const now = documentShown()
      if (now !== before) {
        before = now
        setVisible(now)
      }
    }
    document.addEventListener('visibilitychange', update)
    const unregister = registerStaleDocumentVisibilityRecovery(update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      unregister()
    }
  }, [follow])
  return visible
}

/** The host's stream and count of changes to agy's stored login while `follow` and `visible`;
 *  null before the host answers, and from older hosts. */
function useAgyLoginRevision(
  owner: RuntimeClientTarget,
  follow: boolean,
  visible: boolean
): string | null {
  const [login, setLogin] = useState<string | null>(null)
  const kind = owner.kind
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  useEffect(() => {
    if (!follow || !visible) {
      return
    }
    const target: RuntimeClientTarget =
      kind === 'environment' && environmentId
        ? { kind: 'environment', environmentId }
        : { kind: 'local' }
    const read = () => {
      const snapshot = agyLoginRevisions.read(target)
      setLogin(snapshot.kind === 'known' ? snapshot.state.login : null)
    }
    const unsubscribe = agyLoginRevisions.subscribe(read)
    const release = agyLoginRevisions.observe(target)
    read()
    return () => {
      release()
      unsubscribe()
    }
  }, [follow, visible, kind, environmentId])
  return login
}

/** Re-reads the rows each time the host sees agy's stored login change (a terminal sign-in, a
 *  token refresh), and calls `loginChanged` once they show another login, so errors about the
 *  previous one clear. `follow`: the rows are the host's, whose login agy's stores hold. Returns
 *  whether the window is shown. */
export function useAgyLoginChange(
  owner: RuntimeClientTarget,
  follow: boolean,
  state: AntigravityAccountState | null,
  reread: () => void,
  loginChanged: () => void
): boolean {
  // Showing the window again opens a new stream, whose first answer reads once, since the host
  // stops watching while nothing follows.
  const visible = useWindowShown(follow)
  useOnLaterChange(useAgyLoginRevision(owner, follow, visible), reread)
  useOnLaterChange(loginKey(state), loginChanged)
  return visible
}
