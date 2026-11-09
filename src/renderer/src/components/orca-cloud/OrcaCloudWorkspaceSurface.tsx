import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { returnFocusToWorkspace } from './cloud-focus-return'
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
import { useWakeInput } from './use-wake-input'
import {
  clearWakeInput,
  subscribeWakeInputDelivered
} from '@/components/terminal-pane/input/wake-input-buffer'
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
          setLoad({
            status: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
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
  stalledMessage: string,
  /** Typing is already held for this wake: show its pill now, not after the show delay. */
  immediate = false
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
      // Failures show at once (and wakes the person is already typing into); others only if they
      // outlast the show delay.
      if (failed || immediate) {
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
  }, [effectiveKey, reducedMotion, immediate])

  return { wake: shown?.wake ?? null, leaving }
}

/** Did the pane this layer is about to cover hold focus (or nothing did)? Then the layer takes it. */
function coveredPaneHadFocus(cover: HTMLElement | null): boolean {
  const active = document.activeElement
  const pane = cover?.parentElement
  return !active || active === document.body || Boolean(pane && pane.contains(active))
}

// Shared across covers: an element stays inert while any cover still holds it, and an element
// that was inert before any cover arrived (some other owner) is never released by us.
const inertHolds = new Map<HTMLElement, number>()

function holdInert(element: HTMLElement): void {
  const holds = inertHolds.get(element)
  if (holds === undefined) {
    if (element.inert) {
      return
    }
    element.inert = true
  }
  inertHolds.set(element, (holds ?? 0) + 1)
}

function releaseInert(element: HTMLElement): void {
  const holds = inertHolds.get(element)
  if (holds === undefined) {
    return
  }
  if (holds <= 1) {
    inertHolds.delete(element)
    element.inert = false
  } else {
    inertHolds.set(element, holds - 1)
  }
}

/** Marks every sibling of the cover (the panes it hides) inert while it is shown. */
function useInertSiblings(cover: React.RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const element = cover.current
    const parent = element?.parentElement
    if (!active || !element || !parent) {
      return
    }
    const held: HTMLElement[] = []
    for (const child of Array.from(parent.children)) {
      if (
        child !== element &&
        child instanceof HTMLElement &&
        !child.hasAttribute('data-cloud-surface')
      ) {
        holdInert(child)
        held.push(child)
      }
    }
    return () => held.forEach(releaseInert)
  }, [cover, active])
}

function CloudSurface({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const t = useTranslate()
  const view = useCloudWorkspaceView(workspaceId)
  const name = useAppStore((state) => findWorktreeById(state, workspaceId)?.displayName ?? null)
  const now = useNow(1_000, view.wake !== undefined)
  // Typing is accepted while a wake is in flight, so the terminal stays visible and typeable.
  const wakeInput = useWakeInput(workspaceId)
  useEffect(
    () =>
      subscribeWakeInputDelivered((delivery) => {
        if (delivery.workspaceId === workspaceId && delivery.submitted) {
          // Enter is never replayed into the woken terminal: the person runs it after a look.
          toast(
            t(
              'orcaCloudWorkspace.typedWhileWaking',
              'What you typed is on the prompt. Press Enter to run it.'
            )
          )
        }
      }),
    [workspaceId, t]
  )
  const overlay = useWakeOverlay(
    view.wake,
    Math.max(now, view.wake?.at ?? 0),
    t('orcaCloudWorkspace.overlay.stalled', 'Orca Cloud stopped responding while waking.'),
    wakeInput.pending > 0
  )
  const archived = view.state === 'archived'
  const maybeAsleep =
    view.state === 'sleeping' || view.state === 'failed' || view.state === 'unknown'
  const [archiveLoad, retryArchive] = useArchiveLoad(workspaceId, archived)
  const offline = useCloudOfflineData(workspaceId, maybeAsleep && !archived)
  const asleep = Boolean(offline.snapshot?.asleep) && maybeAsleep
  const wakeInFlight =
    wakeInput.waking ||
    Boolean(
      view.wake &&
      view.wake.phase !== 'failed' &&
      view.wake.phase !== 'ready' &&
      isWakeActive(view.wake, Math.max(now, view.wake.at))
    )

  const layer: 'archived' | 'waking' | 'asleep' | null = archived
    ? 'archived'
    : overlay.wake
      ? 'waking'
      : asleep && !wakeInFlight
        ? 'asleep'
        : null
  const typeThrough = layer === 'waking' && overlay.wake?.phase !== 'failed'

  // "Copy from 14 min ago" only needs a coarse clock, and only while the asleep view shows.
  const slowNow = useNow(30_000, layer === 'asleep')
  const coverRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const [takeFocus, setTakeFocus] = useState(false)
  useInertSiblings(coverRef, layer !== null && !typeThrough && !overlay.leaving)
  useLayoutEffect(() => {
    // Decide once per layer change, before the cover moves focus anywhere. A type-through wake
    // leaves focus in the terminal the person is typing into.
    setTakeFocus(layer !== null && !typeThrough && coveredPaneHadFocus(coverRef.current))
  }, [layer, typeThrough])
  useEffect(() => {
    if (takeFocus && (layer === 'archived' || layer === 'asleep')) {
      headingRef.current?.focus()
    }
  }, [takeFocus, layer])
  const hadLayer = useRef(false)
  useEffect(() => {
    if (layer) {
      hadLayer.current = true
      return
    }
    if (!hadLayer.current) {
      return
    }
    hadLayer.current = false
    // The cover unmounted (wake ready, Dismiss, Unarchive); focus it held fell to <body>.
    const frame = requestAnimationFrame(() =>
      returnFocusToWorkspace(useAppStore.getState().activeTabId, (tabId) =>
        focusTerminalTabSurface(tabId, null, { onlyIfFocusUnclaimed: true })
      )
    )
    return () => cancelAnimationFrame(frame)
  }, [layer])

  const restart = useCallback(() => void runRestartCloudWorkspace(workspaceId), [workspaceId])
  const wake = useCallback(() => {
    dismissCloudWake(workspaceId)
    void wakeCloudWorkspace(workspaceId)
  }, [workspaceId])

  // One persistent, initially empty live region for this surface: phase changes only. A failed
  // wake is announced by its own alert card, so not here too.
  const label = name || t('orcaCloudWorkspace.thisWorkspaceTitle', 'This workspace')
  const announcement =
    layer === 'waking' && overlay.wake && overlay.wake.phase !== 'failed'
      ? overlay.wake.source === 'restart'
        ? t('orcaCloudWorkspace.announce.restarting', 'Restarting {{name}}.', { name: label })
        : overlay.wake.source === 'unarchive'
          ? t('orcaCloudWorkspace.announce.unarchiving', 'Restoring {{name}} from archive.', {
              name: label
            })
          : t('orcaCloudWorkspace.announce.waking', 'Waking {{name}}.', { name: label })
      : layer === 'archived'
        ? t('orcaCloudWorkspace.announce.archived', '{{name}} is archived.', { name: label })
        : layer === 'asleep'
          ? t('orcaCloudWorkspace.announce.asleep', '{{name}} is asleep.', { name: label })
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
          className={
            typeThrough
              ? 'pointer-events-none absolute inset-0 z-30'
              : layer === 'asleep'
                ? 'absolute inset-0 z-20'
                : 'absolute inset-0 z-30'
          }
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
              typeThrough={typeThrough}
              pendingInput={wakeInput.pending}
              onClearPending={() => clearWakeInput(workspaceId)}
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
                  void window.api.orcaCloudOffline
                    .cancelQueuedPrompt({ id })
                    .then(() => offline.refresh())
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
