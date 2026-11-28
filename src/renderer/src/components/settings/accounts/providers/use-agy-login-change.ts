import { useEffect, useRef, useState } from 'react'
import type { AntigravityAccountState } from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { agyLoginRevisions } from '@/runtime/provider-accounts/sign-in/agy-login-revision-store'
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
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

/** The host's count of changes to agy's stored login while `follow` and the window is shown; null
 *  before the host answers, and from older hosts. Showing the window again calls `shown`, since
 *  the host stops watching while nothing follows. */
function useAgyLoginRevision(
  owner: RuntimeClientTarget,
  follow: boolean,
  shown: () => void
): number | null {
  const [visible, setVisible] = useState(documentShown)
  const [revision, setRevision] = useState<number | null>(null)
  const latestShown = useRef(shown)
  useEffect(() => {
    latestShown.current = shown
  })
  const kind = owner.kind
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  useEffect(() => {
    if (!follow) {
      return
    }
    const onVisibility = () => {
      const now = documentShown()
      setVisible(now)
      if (now) {
        latestShown.current()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [follow])
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
      setRevision(snapshot.kind === 'known' ? snapshot.state.revision : null)
    }
    const unsubscribe = agyLoginRevisions.subscribe(read)
    const release = agyLoginRevisions.observe(target)
    read()
    return () => {
      release()
      unsubscribe()
    }
  }, [follow, visible, kind, environmentId])
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
  const loginRevision = useAgyLoginRevision(owner, follow, reread)
  useOnLaterChange(loginRevision === null ? null : String(loginRevision), reread)
  useOnLaterChange(loginKey(state), loginChanged)
}
