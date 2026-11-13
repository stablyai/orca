// The "can't push" notice's state: what installing can do for this person (cloud-push-access), the
// re-checks after Install, Copy request's brief "Copied", and Check again where the App already
// reaches the repository.
import { useEffect, useRef, useState } from 'react'
import {
  openOrcaGitHubAppInstall,
  recheckCloudPushAccess
} from '@/lib/orca-cloud/cloud-setup-notice-actions'
import {
  copyOwnerPushRequest,
  fetchCloudPushAccess,
  type CloudPushAccess
} from '@/lib/orca-cloud/cloud-push-access'

// After Install: GitHub's webhook usually lands within seconds, then the owner may take a while.
const FAST_POLL_MS = 2_000
const FAST_POLL_WINDOW_MS = 3 * 60_000
const SLOW_POLL_MS = 10_000
const GIVE_UP_MS = 30 * 60_000
/** How long "Copied" stays on the request button. */
export const COPIED_MS = 1_500

export type CloudPushNoticeState = {
  access: CloudPushAccess
  installing: boolean
  install: () => void
  copyRequest: () => void
  copied: boolean
  recheck: () => void
  rechecking: boolean
}

/** Polls repo access after Install until the push works, GitHub refuses it, or it gives up. */
function usePushRecheck(
  environmentId: string | undefined,
  hasPush: boolean
): { installing: boolean; startInstall: (repoUrl: string) => void } {
  const [installStartedAt, setInstallStartedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const busy = useRef(false)

  useEffect(() => {
    if (!environmentId || !hasPush || installStartedAt === null) {
      return
    }
    const elapsed = Date.now() - installStartedAt
    if (elapsed > GIVE_UP_MS) {
      setInstallStartedAt(null)
      return
    }
    const timer = setTimeout(
      () => {
        if (busy.current) {
          setTick((n) => n + 1)
          return
        }
        busy.current = true
        void recheckCloudPushAccess(environmentId)
          .then((result) => {
            if (result !== 'waiting') {
              setInstallStartedAt(null)
            }
          })
          .finally(() => {
            busy.current = false
            setTick((n) => n + 1)
          })
      },
      elapsed < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS
    )
    return () => clearTimeout(timer)
  }, [environmentId, hasPush, installStartedAt, tick])

  // Installed somewhere else (the browser, another device): check again when Orca is focused.
  useEffect(() => {
    if (!environmentId || !hasPush) {
      return
    }
    const onFocus = (): void => {
      if (!busy.current) {
        busy.current = true
        void recheckCloudPushAccess(environmentId).finally(() => {
          busy.current = false
        })
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [environmentId, hasPush])

  return {
    installing: installStartedAt !== null,
    startInstall: (repoUrl) => {
      void openOrcaGitHubAppInstall(repoUrl).then((opened) => {
        if (opened) {
          setInstallStartedAt(Date.now())
        }
      })
    }
  }
}

/** What the person can do about the refused push, asked again whenever Orca regains focus. */
function usePushAccess(repoUrl: string | null, hasPush: boolean): CloudPushAccess {
  const [answer, setAnswer] = useState<{ repoUrl: string; access: CloudPushAccess } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!hasPush || !repoUrl) {
      return
    }
    let cancelled = false
    void fetchCloudPushAccess(repoUrl, { force: tick > 0 }).then((access) => {
      if (!cancelled) {
        setAnswer({ repoUrl, access })
      }
    })
    return () => {
      cancelled = true
    }
  }, [hasPush, repoUrl, tick])
  useEffect(() => {
    if (!hasPush || !repoUrl) {
      return
    }
    // An install finished in the browser, or an owner approved the request.
    const onFocus = (): void => setTick((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [hasPush, repoUrl])
  return answer && answer.repoUrl === repoUrl ? answer.access : 'checking'
}

export function useCloudPushNotice(
  environmentId: string | undefined,
  repoUrl: string | null,
  hasPush: boolean
): CloudPushNoticeState {
  const access = usePushAccess(repoUrl, hasPush)
  const push = usePushRecheck(environmentId, hasPush)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const [rechecking, setRechecking] = useState(false)
  const recheckBusy = useRef(false)
  return {
    access,
    installing: push.installing,
    install: () => {
      if (repoUrl) {
        push.startInstall(repoUrl)
      }
    },
    copyRequest: () => {
      if (!repoUrl) {
        return
      }
      void copyOwnerPushRequest(repoUrl).then((ok) => {
        if (ok) {
          setCopied(true)
          clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
        }
      })
    },
    copied,
    recheck: () => {
      if (!environmentId || recheckBusy.current) {
        return
      }
      recheckBusy.current = true
      setRechecking(true)
      // A push that works now drops the line (recheckCloudPushAccess); a refusal keeps it.
      void recheckCloudPushAccess(environmentId).finally(() => {
        recheckBusy.current = false
        setRechecking(false)
      })
    },
    rechecking
  }
}
