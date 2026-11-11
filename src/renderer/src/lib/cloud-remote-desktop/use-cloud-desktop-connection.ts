import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { selectWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'
import { refreshCloudWorkspaceStatus } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useCloudWorkspaceView } from '@/components/orca-cloud/use-cloud-workspace-view'
import type {
  CloudRemoteDesktopFailureCode,
  RemoteDesktopPageState,
  RemoteDesktopPauseReason
} from '../../../../shared/hosted-sandbox/cloud-remote-desktop'
import { requestCloudRemoteDesktop } from './open-cloud-remote-desktop'
import { useRemoteDesktopPageState } from './remote-desktop-page-state'

/** What a remote desktop tab shows, from the sandbox's state and main's word on the page. */
export type CloudDesktopPhase =
  | { kind: 'connected' }
  | { kind: 'connecting' }
  /** Orca is opening the desktop again (after a wake, a dropped forward, an app restart). */
  | { kind: 'reconnecting' }
  | { kind: 'asleep' }
  | { kind: 'waking' }
  | { kind: 'archived' }
  | { kind: 'wakeFailed' }
  /** Reopening failed; the tab names why and offers the next step. */
  | { kind: 'failed'; code: CloudRemoteDesktopFailureCode }
  /** Main stopped retrying; the page itself says why, with Reconnect. */
  | { kind: 'paused'; reason: RemoteDesktopPauseReason }

/** Automatic reopen attempts per outage before the tab waits for Reconnect. */
const MAX_AUTO_ATTEMPTS = 3
const AUTO_RETRY_DELAYS_MS = [0, 2_000, 6_000]

type Attempt =
  | { status: 'idle'; tries: number }
  | { status: 'running'; tries: number }
  | { status: 'failed'; tries: number; code: CloudRemoteDesktopFailureCode }

/** The page has no live session here, or main paused it for a reason a reopen clears. */
export function desktopNeedsSession(page: RemoteDesktopPageState | null): boolean {
  if (!page) {
    return false
  }
  return (
    page.connection === 'none' ||
    (page.connection === 'paused' && (page.reason === 'asleep' || page.reason === 'starting'))
  )
}

export function deriveCloudDesktopPhase(input: {
  isCloud: boolean
  sandbox: string
  page: RemoteDesktopPageState | null
  attempt: Attempt
}): CloudDesktopPhase {
  const { isCloud, sandbox, page, attempt } = input
  if (isCloud) {
    if (sandbox === 'sleeping') {
      return { kind: 'asleep' }
    }
    if (sandbox === 'waking' || sandbox === 'starting') {
      return { kind: 'waking' }
    }
    if (sandbox === 'archived') {
      return { kind: 'archived' }
    }
    if (sandbox === 'wakeFailed') {
      return { kind: 'wakeFailed' }
    }
  }
  if (attempt.status === 'running') {
    return { kind: 'reconnecting' }
  }
  if (desktopNeedsSession(page)) {
    if (attempt.status === 'failed') {
      // Found asleep on the way: say so even before the status poll catches up.
      return attempt.code === 'not_running'
        ? { kind: 'asleep' }
        : { kind: 'failed', code: attempt.code }
    }
    // Reopened every time, yet the page still has no session: stop and offer Reconnect.
    return attempt.tries >= MAX_AUTO_ATTEMPTS
      ? { kind: 'failed', code: 'forward_failed' }
      : { kind: 'reconnecting' }
  }
  if (page?.connection === 'connected') {
    return { kind: 'connected' }
  }
  if (page?.connection === 'paused' && page.reason) {
    return { kind: 'paused', reason: page.reason }
  }
  return { kind: 'connecting' }
}

/**
 * Keeps a remote desktop tab connected: when its page has no session on this computer (the
 * sandbox slept and its forward closed, or Orca restarted) and the sandbox is up, it opens the
 * desktop again and reloads the page onto the new forward, a few times at most per outage.
 */
export function useCloudDesktopConnection({
  enabled,
  worktreeId,
  browserPageId,
  url,
  reload,
  navigate
}: {
  enabled: boolean
  worktreeId: string
  browserPageId: string
  url: string
  reload: () => void
  navigate: (url: string) => void
}): { phase: CloudDesktopPhase; reconnect: () => void } {
  const view = useCloudWorkspaceView(enabled ? worktreeId : '')
  const page = useRemoteDesktopPageState(browserPageId)
  const [attempt, setAttempt] = useState<Attempt>({ status: 'idle', tries: 0 })
  const latest = useRef({ url, reload, navigate })
  latest.current = { url, reload, navigate }
  const inFlight = useRef(false)

  const run = useCallback(
    async (tries: number): Promise<void> => {
      if (inFlight.current) {
        return
      }
      inFlight.current = true
      setAttempt({ status: 'running', tries })
      try {
        const environmentId = selectWorkspaceRuntimeEnvironmentId(
          useAppStore.getState(),
          worktreeId
        )
        const result = environmentId
          ? await requestCloudRemoteDesktop(environmentId)
          : ({ ok: false, code: 'not_cloud' } as const)
        if (!result.ok) {
          if (result.code === 'not_running' || result.code === 'starting') {
            void refreshCloudWorkspaceStatus(worktreeId)
          }
          setAttempt({ status: 'failed', tries, code: result.code })
          return
        }
        // Same forward port: reload so the page picks up the new session; else move the tab to it.
        if (result.url === latest.current.url) {
          latest.current.reload()
        } else {
          latest.current.navigate(result.url)
        }
        setAttempt({ status: 'idle', tries })
      } finally {
        inFlight.current = false
      }
    },
    [worktreeId]
  )

  const sandboxUp = !view.isCloud || view.state === 'running' || view.state === 'unknown'
  const needsSession = desktopNeedsSession(page)
  const connected = page?.connection === 'connected'

  // A connected page, or a sandbox that went down and came back, starts the budget over.
  useEffect(() => {
    if (connected || !sandboxUp) {
      setAttempt((current) => (current.tries === 0 ? current : { status: 'idle', tries: 0 }))
    }
  }, [connected, sandboxUp])

  useEffect(() => {
    if (!enabled || !view.isCloud || !sandboxUp || !needsSession) {
      return
    }
    if (attempt.status === 'running' || attempt.tries >= MAX_AUTO_ATTEMPTS) {
      return
    }
    const timer = setTimeout(
      () => void run(attempt.tries + 1),
      AUTO_RETRY_DELAYS_MS[attempt.tries] ?? 6_000
    )
    return () => clearTimeout(timer)
  }, [enabled, view.isCloud, sandboxUp, needsSession, attempt, run])

  const reconnect = useCallback(() => {
    // A person asked: start over, and reopen even a page main still holds a session for.
    void run(1)
  }, [run])

  return {
    phase: deriveCloudDesktopPhase({
      isCloud: view.isCloud,
      sandbox: view.state,
      page,
      attempt
    }),
    reconnect
  }
}
