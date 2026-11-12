import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { returnFocusToWorkspace } from './cloud-focus-return'
import {
  MENU_FOCUS_RETURN_MS,
  coveredPaneHadFocus,
  isEditable,
  useInertSiblings
} from './cloud-cover-focus'
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
import type { CloudOfflineSnapshot } from '../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { CloudArchivedWorkspaceView, type ArchiveLoad } from './CloudArchivedWorkspaceView'
import { CloudWakingOverlay } from './CloudWakingOverlay'
import { CloudWorkspaceNotice } from './CloudWorkspaceNotice'
import { CloudSetupNoticesDock } from './CloudSetupNotices'
import { useConfirmedRestart } from './use-cloud-panel-actions'
import { useCloudVersionSkewNotice } from './use-cloud-version-skew-notice'
import { CloudWorkspaceOfflineView } from './offline/CloudWorkspaceOfflineView'
import { useCloudOfflineData } from './offline/use-cloud-offline-data'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import {
  useIsWorktreeGoingToSleep,
  useIsWorktreeSleepViewHeld,
  useIsWorktreeSuspendCommitted
} from '@/lib/worktree-sleep-view'
import { useWakeInput, useWakeInputNotices } from './use-wake-input'
import { useWakeAttachHold } from './use-wake-attach-hold'
import { useWakeAfterSleep } from '@/lib/worktree-sleep-wake-request'
import { clearWakeInput } from '@/components/terminal-pane/input/wake-input-buffer'
import { runUnarchiveCloudWorkspace, wakeCloudWorkspace } from './cloud-workspace-actions'
import { keepWorkspaceAwakeDuringSleep } from '@/components/sidebar/workspace-actions/sleep/workspace-sleep-follower'

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
      // Failures show at once (and wakes the person is already typing into, and a wake that
      // started earlier, e.g. on hover, and has already outlasted the delay); others only if they
      // outlast the show delay.
      if (failed || immediate || Date.now() - effective.startedAt >= SHOW_DELAY_MS) {
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

function emptySnapshot(workspaceId: string): CloudOfflineSnapshot {
  return { workspaceId, asleep: true, capturedAt: null, git: null, terminals: [], chats: [] }
}

function CloudSurface({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const t = useTranslate()
  const view = useCloudWorkspaceView(workspaceId)
  const name = useAppStore((state) => findWorktreeById(state, workspaceId)?.displayName ?? null)
  // Ready means the server answers; the pill stays ("Connecting…") until the pane in front has
  // re-attached and can take keys.
  const attachHold = useWakeAttachHold(workspaceId, view.wake)
  // Wake pressed while main still suspends the VM: shown as waking from the press, before main
  // can report (and with the same start once it does).
  const wakeAfterSleep = useWakeAfterSleep(workspaceId)
  const shownWake = attachHold.wake ?? view.wake ?? wakeAfterSleep
  const now = useNow(1_000, shownWake !== undefined)
  // Typing is accepted while a wake is in flight, so the terminal stays visible and typeable.
  const wakeInput = useWakeInput(workspaceId)
  useWakeInputNotices(workspaceId)
  const overlay = useWakeOverlay(
    shownWake,
    Math.max(now, shownWake?.at ?? 0),
    t('orcaCloudWorkspace.overlay.stalled', 'Orca Cloud stopped responding while waking.'),
    wakeInput.pending > 0 || wakeAfterSleep !== undefined
  )
  const archived = view.state === 'archived'
  const maybeAsleep =
    view.state === 'sleeping' || view.state === 'failed' || view.state === 'unknown'
  // Just put to sleep from here: stays on screen read-only, never woken by being shown.
  const viewOnly = useIsWorktreeSleepViewHeld(workspaceId) && !archived
  const goingToSleep = useIsWorktreeGoingToSleep(workspaceId) && viewOnly
  // Past main's last reopen check Keep awake can't work: Wake to continue (an honest wake) instead.
  const suspendCommitted = useIsWorktreeSuspendCommitted(workspaceId)
  const [archiveLoad, retryArchive] = useArchiveLoad(workspaceId, archived)
  const offline = useCloudOfflineData(workspaceId, (maybeAsleep || viewOnly) && !archived)
  const asleep = (Boolean(offline.snapshot?.asleep) && maybeAsleep) || viewOnly
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
    // leaves focus in the terminal the person is typing into; Sleep from here lands on the heading.
    setTakeFocus(
      layer !== null &&
        !typeThrough &&
        ((layer === 'asleep' && viewOnly) || coveredPaneHadFocus(coverRef.current))
    )
  }, [layer, typeThrough, viewOnly])
  useEffect(() => {
    if (!takeFocus || (layer !== 'archived' && layer !== 'asleep')) {
      return
    }
    headingRef.current?.focus()
    if (!viewOnly) {
      return
    }
    // Sleep was chosen from a menu, which hands focus back to its trigger as it closes.
    const timer = setTimeout(() => {
      if (!isEditable(document.activeElement)) {
        headingRef.current?.focus()
      }
    }, MENU_FOCUS_RETURN_MS)
    return () => clearTimeout(timer)
  }, [takeFocus, layer, viewOnly])
  // The sleep ended: re-read the copy so it says asleep, as of the capture main just made.
  const refreshOffline = offline.refresh
  const wasGoingToSleep = useRef(goingToSleep)
  useEffect(() => {
    if (wasGoingToSleep.current && !goingToSleep) {
      void refreshOffline()
    }
    wasGoingToSleep.current = goingToSleep
  }, [goingToSleep, refreshOffline])
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

  // Checked once the sandbox answers; inside the protocol range nothing shows.
  const versionSkewNotice = useCloudVersionSkewNotice(workspaceId, view.state === 'running')
  const restart = useConfirmedRestart(workspaceId)
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
          ? t('orcaCloudWorkspace.announce.unarchivingNamed', 'Unarchiving {{name}}.', {
              name: label
            })
          : t('orcaCloudWorkspace.announce.waking', 'Waking {{name}}.', { name: label })
      : layer === 'archived'
        ? t('orcaCloudWorkspace.announce.archived', '{{name}} is archived.', { name: label })
        : layer === 'asleep' && !goingToSleep
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
  if (layer === null && versionSkewNotice) {
    notices.push(versionSkewNotice)
  }
  // What the environment check found that didn't need to stop the create (env-check-ux).
  const showSetupNotices = layer === null && view.state !== 'sleeping' && view.state !== 'archived'
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
              terminalStalled={attachHold.terminalStalled}
              onRetry={attachHold.terminalStalled ? attachHold.retry : wake}
              onRestart={restart}
              onDismiss={
                attachHold.terminalStalled
                  ? attachHold.dismiss
                  : () => dismissCloudWake(workspaceId)
              }
            />
          ) : layer === 'asleep' && (offline.snapshot || viewOnly) ? (
            <div className="absolute inset-0 flex justify-center overflow-hidden bg-background">
              <CloudWorkspaceOfflineView
                // Kept on screen before (or without) a copy: the header and Wake still show.
                snapshot={offline.snapshot ?? emptySnapshot(workspaceId)}
                queued={offline.queued}
                workspaceName={name}
                now={Math.max(now, slowNow)}
                goingToSleep={goingToSleep}
                onKeepAwake={
                  suspendCommitted ? undefined : () => keepWorkspaceAwakeDuringSleep(workspaceId)
                }
                viewOnly={viewOnly}
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
      {showSetupNotices ? <CloudSetupNoticesDock workspaceId={workspaceId} /> : null}
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
