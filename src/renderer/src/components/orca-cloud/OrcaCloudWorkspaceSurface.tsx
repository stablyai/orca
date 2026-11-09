import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { useNow } from '@/hooks/use-now'
import { isWakeActive } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { dismissCloudOom, useIsCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { CloudArchivedWorkspaceView, type ArchiveLoad } from './CloudArchivedWorkspaceView'
import { CloudWakingOverlay } from './CloudWakingOverlay'
import { CloudWorkspaceNotice } from './CloudWorkspaceNotice'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import {
  runRestartCloudWorkspace,
  runUnarchiveCloudWorkspace,
  wakeCloudWorkspace
} from './cloud-workspace-actions'

const FADE_MS = 220

/**
 * Orca Cloud layer over the active workspace: the archived view, the waking overlay and the
 * unresponsive / out-of-memory notices. Mounted once in the terminal surface; renders nothing
 * for workspaces that are not on Orca Cloud.
 */
export function OrcaCloudWorkspaceSurface({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  const isCloud = useIsCloudWorkspace(worktreeId)
  if (!worktreeId || !isCloud) {
    return null
  }
  return <CloudSurface key={worktreeId} workspaceId={worktreeId} />
}

function useArchiveLoad(workspaceId: string, enabled: boolean): [ArchiveLoad, () => void] {
  const [load, setLoad] = useState<ArchiveLoad>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    void window.api.orcaCloudWorkspace
      .getArchive({ workspaceId })
      .then((result) => {
        if (!cancelled) {
          setLoad(result.ok ? { status: 'ready', archive: result.value } : { status: 'error', message: result.message })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, enabled, attempt])
  return [load, useCallback(() => setAttempt((n) => n + 1), [])]
}

/** Keeps the overlay mounted for one fade after the wake settles, so the terminal appears without a jump. */
function useWakeOverlay(wake: CloudWakeProgressEvent | undefined, now: number): {
  wake: CloudWakeProgressEvent | null
  leaving: boolean
} {
  const reducedMotion = usePrefersReducedMotion()
  const [leaving, setLeaving] = useState<CloudWakeProgressEvent | null>(null)
  const shown = useRef<CloudWakeProgressEvent | null>(null)
  const active = wake && (isWakeActive(wake, now) || wake.phase === 'failed') ? wake : null
  useEffect(() => {
    if (active) {
      shown.current = active
      setLeaving(null)
      return undefined
    }
    if (shown.current && !reducedMotion) {
      const last = shown.current
      shown.current = null
      setLeaving(last)
      const timer = setTimeout(() => setLeaving(null), FADE_MS)
      return () => clearTimeout(timer)
    }
    shown.current = null
    return undefined
  }, [active, reducedMotion])
  if (active) {
    return { wake: active, leaving: false }
  }
  return { wake: leaving, leaving: leaving !== null }
}

function CloudSurface({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const view = useCloudWorkspaceView(workspaceId)
  const name = useAppStore((state) => findWorktreeById(state, workspaceId)?.displayName ?? null)
  const archived = view.state === 'archived'
  const [archiveLoad, retryArchive] = useArchiveLoad(workspaceId, archived)
  const now = useNow(1_000, view.wake !== undefined)
  const overlay = useWakeOverlay(view.wake, Math.max(now, view.wake?.at ?? 0))
  const restart = useCallback(() => void runRestartCloudWorkspace(workspaceId), [workspaceId])

  if (archived) {
    const archive = view.entry?.status?.archive ?? null
    return (
      <CloudArchivedWorkspaceView
        workspaceName={name}
        archivedAt={archive?.archivedAt ?? null}
        expiresAt={archive?.expiresAt ?? null}
        load={archiveLoad}
        unarchiving={view.pending === 'unarchive'}
        onUnarchive={() => void runUnarchiveCloudWorkspace(workspaceId)}
        onRetry={retryArchive}
        onOpenUrl={(url) => void window.api.shell.openUrl(url)}
      />
    )
  }

  const notices: React.ReactNode[] = []
  if (view.state === 'unresponsive' && !overlay.wake) {
    notices.push(
      <CloudWorkspaceNotice
        key="unresponsive"
        notice={{ kind: 'unresponsive' }}
        restarting={view.pending === 'restart'}
        onRestart={restart}
      />
    )
  }
  if (view.oom && !overlay.wake) {
    notices.push(
      <CloudWorkspaceNotice
        key="oom"
        notice={{ kind: 'oom', oom: view.oom }}
        restarting={view.pending === 'restart'}
        onRestart={restart}
        onDismiss={() => dismissCloudOom(workspaceId)}
      />
    )
  }

  return (
    <>
      {overlay.wake ? (
        <CloudWakingOverlay
          wake={overlay.wake}
          workspaceName={name}
          leaving={overlay.leaving}
          onRetry={() => void wakeCloudWorkspace(workspaceId)}
          onRestart={restart}
        />
      ) : null}
      {notices.length > 0 ? (
        <div className="pointer-events-none absolute top-11 right-3 z-30 flex flex-col items-end gap-2">
          {notices}
        </div>
      ) : null}
    </>
  )
}
