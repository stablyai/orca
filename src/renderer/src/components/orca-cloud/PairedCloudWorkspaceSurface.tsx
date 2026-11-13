// SLEEP-IN-PROGRESS (2/2): the Orca Cloud layer over a PAIRED workspace (a "<name> (cloud)" server
// bound to a sandbox; this desktop has no runtime record for it). Same waking overlay as an owned
// workspace; asleep, the read-only copy is the control plane's SEALED snapshot (the only copy a
// paired workspace has), with the saving and failed states after a Sleep pressed here.
import {
  cloudWorkspaceAnnouncement,
  cloudWorkspaceTitle
} from '@/lib/orca-cloud/cloud-workspace-name-copy'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { useNow } from '@/hooks/use-now'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useTranslate } from '@/i18n/use-translate'
import { isWakeActive } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { dismissCloudWake, useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { isPairedCloudStatusRow } from '@/lib/orca-cloud/orca-cloud-workspace-rows'
import { wakePairedCloudWorkspace } from '@/lib/orca-cloud/paired-cloud-wake'
import { resolveCloudRowSandboxId } from '@/lib/orca-cloud/cloud-host-rows'
import { clearSleepCopySave, useSleepCopySave } from '@/lib/worktree-sleep-view'
import {
  sandboxIdForWorktree,
  useCloudWorkspaceIdentities
} from '@/components/cloud-workspaces/cloud-workspace-identity'
import { useCloudReadSnapshot } from '@/components/cloud-workspaces/use-cloud-read-snapshot'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { coveredPaneHadFocus, useInertSiblings } from './cloud-cover-focus'
import { CloudWakingOverlay } from './CloudWakingOverlay'
import { useWakeOverlay } from './use-wake-overlay'
import { useWakeInput, useWakeInputNotices } from './use-wake-input'
import { clearWakeInput } from '@/components/terminal-pane/input/wake-input-buffer'
import { useConfirmedRestart } from './use-cloud-panel-actions'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import { useSleepCopyProgress } from './offline/CloudSleepCopyState'
import {
  CloudReadSnapshotView,
  type CloudReadViewState
} from './read-snapshot/CloudReadSnapshotView'

/** While its copy saves, the sealed snapshot is re-read this often (a read is otherwise once). */
export const SEALED_COPY_POLL_MS = 2_500

/** Is this row PAIRED (cloud status, but not this desktop's own cloud workspace)? */
export function useIsPairedCloudRow(workspaceId: string | null): boolean {
  return useCloudWorkspace((s) => workspaceId !== null && isPairedCloudStatusRow(s, workspaceId))
}

/** The sandbox behind the paired row; `settled` once a lookup has answered (null: none found). */
function usePairedSandboxId(
  workspaceId: string,
  enabled: boolean
): { sandboxId: string | null; settled: boolean } {
  const environmentId = useCloudWorkspace((s) => s.paired[workspaceId] ?? null)
  const hostId = environmentId ? toRuntimeExecutionHostId(environmentId) : null
  const identities = useCloudWorkspaceIdentities()
  const known = sandboxIdForWorktree({ id: workspaceId, hostId }, identities)
  const [resolved, setResolved] = useState<{ sandboxId: string | null } | null>(null)
  useEffect(() => {
    if (!enabled || known) {
      return
    }
    let live = true
    // A pairing may be newer than the bindings this window loaded: re-read them first.
    void resolveCloudRowSandboxId({ id: workspaceId, hostId }).then((sandboxId) => {
      if (live) {
        setResolved({ sandboxId })
      }
    })
    return () => {
      live = false
    }
  }, [enabled, known, workspaceId, hostId])
  return { sandboxId: known ?? resolved?.sandboxId ?? null, settled: known !== null || !!resolved }
}

/** The sealed copy, re-read every SEALED_COPY_POLL_MS while it saves; a new-enough one ends saving. */
function usePairedSealedCopy(
  workspaceId: string,
  sandboxId: string | null
): ReturnType<typeof useCloudReadSnapshot> & { copySave: 'saving' | 'failed' | null } {
  const read = useCloudReadSnapshot(sandboxId)
  const capturedAt = read.state.kind === 'ready' ? read.state.snapshot.capturedAt : undefined
  const copySave = useSleepCopyProgress(workspaceId, capturedAt)
  const polling = copySave === 'saving' && sandboxId !== null
  // A ref, so a new `retry` per render never reinstalls the poller (it runs once on install).
  const retryRef = useRef(read.retry)
  retryRef.current = read.retry
  useEffect(() => {
    if (!polling) {
      return
    }
    // The first read already ran when the view opened; re-read on the cadence after that.
    let first = true
    // Paused while the window is hidden; ends as soon as the copy is in (saving clears).
    return installWindowVisibilityInterval({
      run: () => {
        if (first) {
          first = false
          return
        }
        retryRef.current()
      },
      intervalMs: SEALED_COPY_POLL_MS,
      slowWhileUnfocused: false
    })
  }, [polling])
  return { ...read, copySave }
}

export function PairedCloudWorkspaceSurface({
  workspaceId
}: {
  workspaceId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const view = useCloudWorkspaceView(workspaceId, { pairedRows: true })
  const name = useAppStore((state) => findWorktreeById(state, workspaceId)?.displayName ?? null)
  const now = useNow(1_000, view.wake !== undefined)
  // PAIRED-WAKE-TYPE-THROUGH: typing is held while it wakes and delivered to the woken terminal,
  // exactly as for an owned workspace (the store begins and ends the hold on wake progress).
  const wakeInput = useWakeInput(workspaceId)
  useWakeInputNotices(workspaceId)
  const overlay = useWakeOverlay(
    view.wake,
    Math.max(now, view.wake?.at ?? 0),
    t('orcaCloudWorkspace.overlay.stalled', 'Orca Cloud stopped responding while waking.'),
    wakeInput.pending > 0
  )
  const copySaveEntry = useSleepCopySave(workspaceId)
  const wakeInFlight = Boolean(
    view.wake &&
    view.wake.phase !== 'failed' &&
    view.wake.phase !== 'ready' &&
    isWakeActive(view.wake, Math.max(now, view.wake.at))
  )
  // Sleep pressed here: its status read can still say ready, but it is going to sleep.
  const asleep =
    !wakeInFlight &&
    view.state !== 'archived' &&
    (view.state === 'sleeping' || copySaveEntry?.state === 'saving')
  const layer: 'waking' | 'asleep' | null = overlay.wake ? 'waking' : asleep ? 'asleep' : null

  const sandbox = usePairedSandboxId(workspaceId, layer === 'asleep')
  const copy = usePairedSealedCopy(workspaceId, layer === 'asleep' ? sandbox.sandboxId : null)
  // No sandbox behind the row after a fresh lookup: never a skeleton forever.
  const readState: CloudReadViewState =
    sandbox.settled && !sandbox.sandboxId ? { kind: 'not_found' } : copy.state
  const slowNow = useNow(30_000, layer === 'asleep')
  const restart = useConfirmedRestart(workspaceId)

  // While it wakes the pane stays typeable under the overlay (a failed wake covers it again).
  const typeThrough = layer === 'waking' && overlay.wake?.phase !== 'failed'
  const coverRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const [takeFocus, setTakeFocus] = useState(false)
  useInertSiblings(coverRef, layer !== null && !typeThrough && !overlay.leaving)
  useLayoutEffect(() => {
    setTakeFocus(layer !== null && coveredPaneHadFocus(coverRef.current))
  }, [layer])
  useEffect(() => {
    if (takeFocus && layer === 'asleep') {
      headingRef.current?.focus()
    }
  }, [takeFocus, layer])

  const wake = (): void => {
    // Woken: no copy is coming any more.
    clearSleepCopySave(workspaceId)
    void wakePairedCloudWorkspace(workspaceId, { source: 'open' })
  }
  const label = cloudWorkspaceTitle(name, t)
  const announcement =
    layer === 'waking' && overlay.wake && overlay.wake.phase !== 'failed'
      ? cloudWorkspaceAnnouncement('waking', name, t)
      : layer === 'asleep' && copy.copySave !== 'saving'
        ? cloudWorkspaceAnnouncement('asleep', name, t)
        : ''

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
          data-cloud-paired=""
        >
          {layer === 'waking' && overlay.wake ? (
            <CloudWakingOverlay
              wake={overlay.wake}
              workspaceName={name}
              leaving={overlay.leaving}
              autoFocus={takeFocus}
              typeThrough={typeThrough}
              pendingInput={wakeInput.pending}
              onClearPending={() => clearWakeInput(workspaceId)}
              onRetry={() => void wakePairedCloudWorkspace(workspaceId)}
              onRestart={restart}
              onDismiss={() => dismissCloudWake(workspaceId)}
            />
          ) : layer === 'asleep' ? (
            <div className="absolute inset-0 overflow-y-auto bg-background scrollbar-sleek">
              <div className="mx-auto flex max-w-3xl px-6 py-8">
                <CloudReadSnapshotView
                  title={label}
                  state={readState}
                  now={Math.max(now, slowNow)}
                  wake={null}
                  onWake={wake}
                  onRetry={copy.retry}
                  retrying={copy.retrying}
                  copySave={copy.copySave}
                  headingRef={headingRef}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
