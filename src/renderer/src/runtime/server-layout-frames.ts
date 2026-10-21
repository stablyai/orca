// A paired server whose main takes layout intents (`layout.intents.v1`) draws its workspaces in
// this window from its layout stream instead of the session.tabs mirror (design H5). One source per
// workspace at a time: the mirror stops writing a workspace's layout as the stream's snapshot comes
// in, and gets it back, with a fresh snapshot, when the stream stops. session.tabs keeps flowing for
// terminal handles and statuses either way.

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import {
  LAYOUT_INTENTS_RUNTIME_CAPABILITY,
  LAYOUT_REOPEN_HELD_PANES_CAPABILITY
} from '../../../shared/workspace-layout/layout-intents-capability'
import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from './runtime-host-connection-state'
import { createServerLayoutFrameTranslator } from './server-layout-frame-ids'
import { serverHeldPanes, showServerLayoutHeldPanes } from './server-held-panes'
import { createServerViewReport, onServerControlConnected } from './server-layout-view-report'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { mirroredRuntimeEnvironmentIdForWorkspace } from './web-session-tabs-sync/mirrored-workspace-owner'
import {
  isFrameDrawnServerWorkspace,
  mirroredTerminalHandle,
  onMirroredTerminalHandlesChanged,
  resyncMirroredServerWorkspace,
  setFrameDrawnServerWorkspaces
} from './web-session-tabs-sync/frame-drawn-server-workspaces'

type FramesStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
  subscribe: (listener: (state: AppState) => void) => () => void
}

type ServerFrames = {
  /** Hands the server's workspaces back to the mirror unless a replacement stream takes them. */
  close: (handBack: boolean) => void
  /** The workspaces the mirror leaves to this stream now. */
  gated: () => ReadonlySet<string>
}

/** Workspaces this server's stream draws: ones the window holds that it mirrors from this server. */
function serverDraws(environmentId: string): (state: AppState) => (key: string) => boolean {
  return (state) => (key) =>
    (key in state.groupsByWorktree || key in state.unifiedTabsByWorktree) &&
    mirroredRuntimeEnvironmentIdForWorkspace(state, key) === environmentId
}

function openServerFrames(
  store: FramesStore,
  environmentId: string,
  /** A replaced stream's workspaces: this one hands them back if it never takes them over. */
  inherited: ReadonlySet<string>
): ServerFrames {
  const translator = createServerLayoutFrameTranslator(
    environmentId,
    (worktreeId) => (hostTabId, leafId) =>
      mirroredTerminalHandle(environmentId, worktreeId, hostTabId, leafId)
  )
  const owns = (key: string): boolean =>
    mirroredRuntimeEnvironmentIdForWorkspace(store.getState(), key) === environmentId
  let gated = inherited
  /** From the stream's snapshot until it stops: only then do its frames draw. */
  let live = false
  /** Gates `keys`; a workspace leaving the gate that is still this server's returns to the mirror. */
  const gate = (keys: ReadonlySet<string>): void => {
    const returned = [...gated].filter((key) => !keys.has(key) && owns(key))
    gated = keys
    setFrameDrawnServerWorkspaces(environmentId, keys)
    for (const key of returned) {
      // The frame tree stays until the fresh snapshot replaces it: never an empty tree between.
      resyncMirroredServerWorkspace(environmentId, key).catch((error: unknown) => {
        console.warn('[layout-owner] a server workspace could not return to the mirror:', error)
      })
    }
  }
  /** Gates the workspaces the stream holds that are this server's; returns the ones newly gated. */
  const regate = (): string[] => {
    const keys = new Set(translator.keys().filter(owns))
    const added = [...keys].filter((key) => !gated.has(key))
    if (added.length > 0 || keys.size !== gated.size) {
      gate(keys)
    }
    return added
  }
  /** The banner shows the held panes of the workspaces these frames draw, when the server can reopen them. */
  const showHeld = (): void => {
    const status = lastVerifiedRuntimeStatus(
      store.getState().runtimeStatusByEnvironmentId.get(environmentId)
    )
    const reopens = status?.capabilities?.includes(LAYOUT_REOPEN_HELD_PANES_CAPABILITY) === true
    showServerLayoutHeldPanes(
      environmentId,
      live && reopens
        ? serverHeldPanes([...gated].flatMap((key) => translator.serverLayout(key) ?? []))
        : []
    )
  }
  const handBack = (): void => {
    live = false
    gate(new Set())
    showHeld()
  }
  const draws = serverDraws(environmentId)
  const viewReport = createServerViewReport(environmentId)
  /** The server may hold none of this window's reports: a new stream or control socket. */
  const reportCurrent = (): void => {
    if (live) {
      viewReport.update(store.getState().activeGroupIdByWorktree, gated)
    }
  }
  const reportAgain = (): void => {
    viewReport.reset()
    reportCurrent()
  }
  const stopControlWatch = onServerControlConnected(environmentId, reportAgain)
  /** True while the sync writes a frame: a group it moves is the server's doing, not the user's. */
  let applyingFrames = false
  const frameStore: FramesStore = {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    setState: (patch) => {
      const previous = applyingFrames
      applyingFrames = true
      try {
        store.setState(patch)
      } finally {
        applyingFrames = previous
      }
    }
  }

  const sync = openWorkspaceLayoutFrameSync(frameStore, {
    target: { kind: 'environment', environmentId },
    // Only gated workspaces: a handed-back one is the mirror's, whatever the frozen frames still hold.
    draws: (state) => {
      const ours = draws(state)
      return (key) => gated.has(key) && ours(key)
    },
    translate: (frame) => {
      const translated = translator.translate(frame)
      live ||= frame.type === 'snapshot'
      if (frame.type === 'snapshot') {
        viewReport.reset()
        // Two hops, past the flush the sync queues after this returns: if applying the snapshot
        // changed nothing in the store, nothing has re-sent the view yet.
        queueMicrotask(() => queueMicrotask(reportCurrent))
      }
      // Before the frame shows: the mirror must not write a workspace the frames now draw.
      regate()
      showHeld()
      return translated
    },
    onStatus: (status) => {
      if (status.state === 'lost' || status.state === 'refused') {
        handBack()
      }
    }
  })
  // A workspace can turn out to be this server's after its snapshot (pairing just finished): it is
  // gated, then drawn, as the routing that names it arrives.
  let routing: unknown[] = []
  const stopRouting = store.subscribe((state) => {
    if (live) {
      viewReport.update(state.activeGroupIdByWorktree, gated, applyingFrames)
    }
    const next = routingInputs(state)
    if (sameValues(next, routing)) {
      return
    }
    routing = next
    const added = live ? regate() : []
    showHeld()
    if (added.length > 0) {
      // The mirror may have drawn them meanwhile.
      sync.redraw(added)
    }
  })
  const stopHandles = onMirroredTerminalHandlesChanged((environment, worktreeId) => {
    const frame = environment === environmentId ? translator.rebind(worktreeId) : null
    if (frame) {
      sync.receive(frame)
    }
  })
  sync.start()
  return {
    gated: () => gated,
    close: (returnWorkspaces) => {
      stopRouting()
      stopHandles()
      stopControlWatch()
      sync.close()
      if (returnWorkspaces) {
        handBack()
      } else {
        showServerLayoutHeldPanes(environmentId, [])
      }
    }
  }
}

/** Opens one stream per reachable server advertising the capability; reopens on a new runtime or
 *  pairing, and closes when the server is removed or stops advertising it. */
export function installServerLayoutFrames(store: FramesStore): () => void {
  const open = new Map<string, { identity: string; frames: ServerFrames }>()
  let inputs: unknown[] = []
  const reconcile = (state: AppState): void => {
    const next = [state.runtimeEnvironments, state.runtimeStatusByEnvironmentId]
    if (sameValues(next, inputs)) {
      return
    }
    inputs = next
    const wanted = new Map<string, string>()
    for (const environment of state.runtimeEnvironments) {
      const entry = state.runtimeStatusByEnvironmentId.get(environment.id)
      const status = lastVerifiedRuntimeStatus(entry)
      // Why every paired server, not the focused one: each draws only the workspaces it owns.
      if (
        status?.capabilities?.includes(LAYOUT_INTENTS_RUNTIME_CAPABILITY) &&
        !isDisconnectedRuntimeHostState(runtimeHostConnectionStateForEntry(entry))
      ) {
        wanted.set(
          environment.id,
          `${status.runtimeId}|${environment.pairingRevision ?? environment.createdAt}|${entry?.connectionGeneration ?? 0}`
        )
      }
    }
    const replaced = new Map<string, ReadonlySet<string>>()
    for (const [environmentId, entry] of open) {
      if (wanted.get(environmentId) !== entry.identity) {
        open.delete(environmentId)
        // A replacement stream's snapshot takes the workspaces over; anything else returns them.
        const replacing = wanted.has(environmentId)
        entry.frames.close(!replacing)
        if (replacing) {
          replaced.set(environmentId, entry.frames.gated())
        }
      }
    }
    for (const [environmentId, identity] of wanted) {
      if (!open.has(environmentId)) {
        const frames = openServerFrames(
          store,
          environmentId,
          replaced.get(environmentId) ?? new Set()
        )
        open.set(environmentId, { identity, frames })
      }
    }
  }
  reconcile(store.getState())
  const stop = store.subscribe(reconcile)
  return () => {
    stop()
    for (const { frames } of open.values()) {
      frames.close(true)
    }
    open.clear()
  }
}

/** The store slices a workspace's owning server derives from. */
function routingInputs(state: AppState): unknown[] {
  return [
    state.repos,
    state.worktreesByRepo,
    state.detectedWorktreesByRepo,
    state.projectGroups,
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    state.runtimeEnvironments,
    state.runtimeStatusByEnvironmentId
  ]
}

/** Compared by reference: store slices are replaced, never edited in place. */
function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

let installed: (() => void) | null = null

/** After restore: each capable paired server's workspaces draw from its stream from now on. */
export function showServerLayoutFrames(): void {
  // Kept for the document's life: a re-run boot reuses the streams already open.
  installed ??= installServerLayoutFrames(useAppStore)
  if (import.meta.env.MODE === 'e2e') {
    window.__isFrameDrawnServerWorkspaceE2E = isFrameDrawnServerWorkspace
  }
}
