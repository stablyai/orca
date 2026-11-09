import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import {
  WAKE_STALE_MS,
  isWakeActive,
  isWakeFailedFresh
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  dismissCloudOom,
  dismissCloudWake,
  useIsCloudWorkspace
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { CloudArchivedWorkspaceView, type ArchiveLoad } from './CloudArchivedWorkspaceView'
import { CloudWakingOverlay } from './CloudWakingOverlay'
import { CloudWorkspaceNotice } from './CloudWorkspaceNotice'
import { CloudWorkspaceOfflineView } from './offline/CloudWorkspaceOfflineView'
import { useCloudOfflineData } from './offline/use-cloud-offline-data'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import {
  runRestartCloudWorkspace,
  runUnarchiveCloudWorkspace,
  wakeCloudWorkspace
} from './cloud-workspace-actions'

/** A wake that settles faster than this never shows the overlay (no skeleton flash). */
const SHOW_DELAY_MS = 300
/** Once shown, the overlay stays at least this long so it never blinks. */
const MIN_HOLD_MS = 600
const FADE_MS = 200

/**
 * The Orca Cloud layer over the active workspace, one mount for all of it: the archived view,
 * the "Waking…" overlay, the asleep (cached, read-only) view, and the not-responding / out-of-
 * memory notices. Covering layers make the panes under them inert and take focus when the
 * covered pane had it. Renders nothing for workspaces that are not on Orca Cloud.
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
  // Keyed: switching worktrees resets every piece of per-workspace state.
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
          setLoad(
            result.ok
              ? { status: 'ready', archive: result.value }
              : { status: 'error', message: result.message }
          )
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

/**
 * The wake the overlay shows: shown after SHOW_DELAY_MS, held at least MIN_HOLD_MS, faded out
 * after. A wake that stops reporting turns into a failure instead of quietly vanishing.
 */
function useWakeOverlay(
  wake: CloudWakeProgressEvent | undefined,
  now: number,
  stalledMessage: string
): { wake: CloudWakeProgressEvent | null; leaving: boolean } {
  const reducedMotion = usePrefersReducedMotion()
  const effective: CloudWakeProgressEvent | null = !wake
    ? null
    : isWakeActive(wake, now)
      ? wake
      : isWakeFailedFresh(wake, now)
        ? wake
        : (wake.phase === 'waking' || wake.phase === 'connecting') && now - wake.at >= WAKE_STALE_MS
          ? { ...wake, phase: 'failed', message: stalledMessage }
          : null
  const failed = effective?.phase === 'failed'
  const [shown, setShown] = useState<{ wake: CloudWakeProgressEvent; at: number } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const effectiveKey = effective ? `${effective.startedAt}:${effective.phase}` : null
  const latest = useRef(effective)
  latest.current = effective

  useEffect(() => {
    if (effective) {
      setLeaving(false)
      if (shown) {
        setShown({ wake: effective, at: shown.at })
        return undefined
      }
      // Failures show at once; wakes only if they outlast the show delay.
      if (failed) {
        setShown({ wake: effective, at: Date.now() })
        return undefined
      }
      const timer = setTimeout(() => {
        if (latest.current) {
          setShown({ wake: latest.current, at: Date.now() })
        }
      }, SHOW_DELAY_MS)
      return () => clearTimeout(timer)
    }
    if (!shown) {
      return undefined
    }
    const hold = Math.max(0, shown.at + MIN_HOLD_MS - Date.now())
    const fade = reducedMotion ? 0 : FADE_MS
    const startFade = setTimeout(() => setLeaving(fade > 0), hold)
    const hide = setTimeout(() => {
      setLeaving(false)
      setShown(null)
    }, hold + fade)
    return () => {
      clearTimeout(startFade)
      clearTimeout(hide)
    }
    // `shown` is read, not tracked: a re-run per show would restart the hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKey, reducedMotion])

  return { wake: shown?.wake ?? null, leaving }
}

/** Did the pane this layer is about to cover hold focus (or nothing did)? Then the layer takes it. */
function coveredPaneHadFocus(cover: HTMLElement | null): boolean {
  const active = document.activeElement
  const pane = cover?.parentElement
  return !active || active === document.body || Boolean(pane && pane.contains(active))
}

/** Marks every sibling of the cover (the panes it hides) inert while it is shown. */
function useInertSiblings(cover: React.RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const element = cover.current
    const parent = element?.parentElement
    if (!active || !element || !parent) {
      return
    }
    const changed: HTMLElement[] = []
    for (const child of Array.from(parent.children)) {
      if (
        child !== element &&
        child instanceof HTMLElement &&
        !child.hasAttribute('data-cloud-surface') &&
        !child.inert
      ) {
        child.inert = true
        changed.push(child)
      }
    }
    return () => {
      for (const child of changed) {
        child.inert = false
      }
    }
  }, [cover, active])
}

function CloudSurface({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const t = useTranslate()
  const view = useCloudWorkspaceView(workspaceId)
  const name = useAppStore((state) => findWorktreeById(state, workspaceId)?.displayName ?? null)
  const now = useNow(1_000, view.wake !== undefined)
  const overlay = useWakeOverlay(
    view.wake,
    Math.max(now, view.wake?.at ?? 0),
    t('orcaCloudWorkspace.overlay.stalled', 'Orca Cloud stopped responding while waking.')
  )
  const archived = view.state === 'archived'
  const maybeAsleep =
    view.state === 'sleeping' || view.state === 'failed' || view.state === 'unknown'
  const [archiveLoad, retryArchive] = useArchiveLoad(workspaceId, archived)
  const offline = useCloudOfflineData(workspaceId, maybeAsleep && !archived)
  const asleep = Boolean(offline.snapshot?.asleep) && maybeAsleep

  const layer: 'archived' | 'waking' | 'asleep' | null = archived
    ? 'archived'
    : overlay.wake
      ? 'waking'
      : asleep
        ? 'asleep'
        : null

  // "Copy from 14 min ago" only needs a coarse clock, and only while the asleep view shows.
  const slowNow = useNow(30_000, layer === 'asleep')
  const coverRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const [takeFocus, setTakeFocus] = useState(false)
  useInertSiblings(coverRef, layer !== null && !overlay.leaving)
  useLayoutEffect(() => {
    // Decide once per layer change, before the cover moves focus anywhere.
    setTakeFocus(layer !== null && coveredPaneHadFocus(coverRef.current))
  }, [layer])
  useEffect(() => {
    if (takeFocus && (layer === 'archived' || layer === 'asleep')) {
      headingRef.current?.focus()
    }
  }, [takeFocus, layer])

  const restart = useCallback(() => void runRestartCloudWorkspace(workspaceId), [workspaceId])
  const wake = useCallback(() => {
    dismissCloudWake(workspaceId)
    void wakeCloudWorkspace(workspaceId)
  }, [workspaceId])

  // One persistent, initially empty live region for this surface: phase changes only.
  const announcement =
    layer === 'waking' && overlay.wake
      ? overlay.wake.phase === 'failed'
        ? t('orcaCloudWorkspace.announce.failed', 'Couldn’t wake {{name}}.', { name: name ?? '' })
        : t('orcaCloudWorkspace.announce.waking', 'Waking {{name}}.', { name: name ?? '' })
      : layer === 'archived'
        ? t('orcaCloudWorkspace.announce.archived', '{{name}} is archived.', { name: name ?? '' })
        : layer === 'asleep'
          ? t('orcaCloudWorkspace.announce.asleep', '{{name}} is asleep.', { name: name ?? '' })
          : ''

  const notices: React.ReactNode[] = []
  if (layer === null && view.state === 'unresponsive') {
    notices.push(
      <CloudWorkspaceNotice
        key="unresponsive"
        notice={{ kind: 'unresponsive' }}
        restarting={view.pending === 'restart'}
        onRestart={restart}
      />
    )
  }
  if (layer === null && view.oom) {
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
      <div role="status" className="sr-only" data-cloud-surface="">
        {announcement}
      </div>
      {layer ? (
        <div
          ref={coverRef}
          className={layer === 'asleep' ? 'absolute inset-0 z-20' : 'absolute inset-0 z-30'}
          data-cloud-cover={layer}
        >
          {layer === 'archived' ? (
            <CloudArchivedWorkspaceView
              workspaceName={name}
              archivedAt={view.entry?.status?.archive?.archivedAt ?? null}
              expiresAt={view.entry?.status?.archive?.expiresAt ?? null}
              load={archiveLoad}
              unarchiving={view.pending === 'unarchive'}
              onUnarchive={() => void runUnarchiveCloudWorkspace(workspaceId)}
              onRetry={retryArchive}
              onOpenUrl={(url) => void window.api.shell.openUrl(url)}
              headingRef={headingRef}
            />
          ) : layer === 'waking' && overlay.wake ? (
            <CloudWakingOverlay
              wake={overlay.wake}
              workspaceName={name}
              leaving={overlay.leaving}
              autoFocus={takeFocus}
              onRetry={wake}
              onRestart={restart}
              onDismiss={() => dismissCloudWake(workspaceId)}
            />
          ) : layer === 'asleep' && offline.snapshot ? (
            <div className="absolute inset-0 flex justify-center overflow-hidden bg-background">
              <CloudWorkspaceOfflineView
                snapshot={offline.snapshot}
                queued={offline.queued}
                workspaceName={name}
                now={Math.max(now, slowNow)}
                headingRef={headingRef}
                onWake={wake}
                onQueue={async (sessionId, text) => {
                  const answer = await window.api.orcaCloudOffline.queuePrompt({
                    workspaceId,
                    sessionId,
                    text
                  })
                  if (!answer.ok) {
                    toast.error(answer.message)
                    return false
                  }
                  void offline.refresh()
                  return true
                }}
                onCancel={(id) =>
                  void window.api.orcaCloudOffline.cancelQueuedPrompt({ id }).then(() => offline.refresh())
                }
                onEdit={async (id, text) => {
                  const saved = await window.api.orcaCloudOffline.editQueuedPrompt({ id, text })
                  void offline.refresh()
                  return saved
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {notices.length > 0 ? (
        <div
          data-cloud-surface=""
          className="pointer-events-none absolute top-11 right-3 z-30 flex flex-col items-end gap-2"
        >
          {notices}
        </div>
      ) : null}
    </>
  )
}
