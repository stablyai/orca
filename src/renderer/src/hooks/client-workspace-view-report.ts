import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ClientWorkspaceView } from '../../../shared/rpc-contract/client-workspace-view-params'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { onScreenHostId } from '@/store/slices/workspace-attention/workspace-unread-flag'
import { presenceRemainingMs, subscribeAutoAckPresenceSignals } from './agent-auto-ack-presence'
import type { AutoAckTabTarget } from './agent-auto-ack-targets'

// Refresh while present so host presence trails by at most this interval and reconnect relearns the view.
const REFRESH_MS = 10_000

type HostView = {
  target: RuntimeClientTarget
  workspaceIds: string[]
  tabIds: string[]
  signature: string
}
/** `signature` null: the send failed, and is retried once REFRESH_MS has passed. */
type SentView = {
  target: RuntimeClientTarget
  signature: string | null
  sentAt: number
  present: boolean
}

export type ClientWorkspaceViewReporter = {
  /** The scan's screen: its workspaces and tabs, empty while the window is hidden or unfocused. */
  update: (
    state: AppState,
    workspaceIds: readonly string[],
    targets: readonly AutoAckTabTarget[]
  ) => void
  renewPresence: () => void
}

function targetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

/** Report each host’s on-screen workspaces to suppress viewed unread flags; send empty when its workspaces leave the screen. */
export function createClientWorkspaceViewReporter(
  send: (target: RuntimeClientTarget, view: ClientWorkspaceView) => Promise<unknown> = (
    target,
    view
  ) => callRuntimeRpc(target, 'sidebarInputs.reportView', view)
): ClientWorkspaceViewReporter {
  let views = new Map<string, HostView>()
  const sent = new Map<string, SentView>()

  const flush = (): void => {
    const now = Date.now()
    const presentForMs = presenceRemainingMs()
    const present = presentForMs !== 0
    for (const key of new Set([...sent.keys(), ...views.keys()])) {
      const view = views.get(key)
      const previous = sent.get(key)
      const target = view?.target ?? previous?.target
      const failed = previous?.signature === null
      if (!target || (failed && now - previous.sentAt < REFRESH_MS)) {
        continue
      }
      const refreshes =
        view !== undefined &&
        previous !== undefined &&
        present &&
        (!previous.present || now - previous.sentAt >= REFRESH_MS)
      if (!failed && previous?.signature === view?.signature && !refreshes) {
        continue
      }
      const entry = view && { target, signature: view.signature, sentAt: now, present }
      if (entry) {
        sent.set(key, entry)
      } else {
        sent.delete(key)
      }
      // Rate-limit failed/missing reportView retries, including empty reports, so trusted input cannot flood older hosts.
      void send(target, {
        workspaceIds: view?.workspaceIds ?? [],
        tabIds: view?.tabIds ?? [],
        // Held one refresh longer than the window's, so the host never drops a present user first.
        presentForMs: presentForMs ? presentForMs + REFRESH_MS : presentForMs
      }).catch(() => {
        if (sent.get(key) === entry) {
          sent.set(key, { target, signature: null, sentAt: now, present })
        }
      })
    }
  }

  return {
    update: (state, workspaceIds, targets) => {
      const next = new Map<string, HostView>()
      const hostView = (workspaceId: string): HostView | null => {
        const target = tryRuntimeTargetForWorktreeOwner(
          state,
          workspaceId,
          onScreenHostId(state, workspaceId) ?? undefined
        )
        if (!target) {
          return null
        }
        const key = targetKey(target)
        let view = next.get(key)
        if (!view) {
          view = { target, workspaceIds: [], tabIds: [], signature: '' }
          next.set(key, view)
        }
        return view
      }
      for (const workspaceId of workspaceIds) {
        hostView(workspaceId)?.workspaceIds.push(workspaceId)
      }
      for (const target of targets) {
        if (target.worktreeId !== null) {
          hostView(target.worktreeId)?.tabIds.push(target.tabId)
        }
      }
      for (const view of next.values()) {
        view.signature = JSON.stringify([view.workspaceIds, view.tabIds])
      }
      views = next
      flush()
    },
    renewPresence: flush
  }
}

/** The scan's presence signals plus blur: a window still visible but behind another app shows nothing. */
export function subscribeViewReportPresenceSignals(
  onRescan: () => void,
  onInput: () => void
): () => void {
  const stop = subscribeAutoAckPresenceSignals(onRescan, onInput)
  window.addEventListener('blur', onRescan)
  return () => {
    stop()
    window.removeEventListener('blur', onRescan)
  }
}
