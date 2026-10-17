import { useEffect, useSyncExternalStore } from 'react'
import type {
  DebugOutputEvent,
  DebugSnapshot,
  DebugStackFrameWire,
  DebugWorktree
} from '../../../../preload/api/debug-api'
import { debugClient, type DebugClient } from './debug-client'

export const DEBUG_CONSOLE_LINE_CAP = 2000

export type DebugConsoleLine = {
  seq: number
  ts: number
  category: string
  text: string
}

export type DebugSessionState = {
  snapshot: DebugSnapshot | null
  selectedThreadId: number | null
  /** Frames of the selected thread, as last loaded. */
  frames: DebugStackFrameWire[]
  selectedFrameId: number | null
  console: DebugConsoleLine[]
  /** The run panel's chosen launch configuration. */
  configName: string | null
  /** Bumped on every thread reset, so a stack trace answered for an earlier stop is dropped. */
  selectionEpoch: number
  /** The seq of the newest stopped snapshot: a step re-stops the same thread, and views refresh on it. */
  stopSeq: number
  /** Output high-water mark, kept apart from the console so a clear does not admit a replay. */
  outputSeq: number
}

export const EMPTY_DEBUG_SESSION: DebugSessionState = Object.freeze({
  snapshot: null,
  selectedThreadId: null,
  frames: [],
  selectedFrameId: null,
  console: [],
  configName: null,
  selectionEpoch: 0,
  stopSeq: 0,
  outputSeq: 0
})

export type DebugSessionStore = ReturnType<typeof createDebugSessionStore>

/** Keyed by the realpath core reports in snapshot.worktreePath, never a renderer-derived path. */
export function createDebugSessionStore(
  client: Pick<DebugClient, 'onState' | 'onOutput' | 'stackTrace'>
) {
  const sessions = new Map<string, DebugSessionState>()
  // Snapshots carry no repoId; a view binds it so the store can load the stopped stack itself.
  const repos = new Map<string, string>()
  const listeners = new Set<() => void>()
  let disconnect: (() => void) | null = null

  const getState = (worktreePath: string): DebugSessionState =>
    sessions.get(worktreePath) ?? EMPTY_DEBUG_SESSION

  function update(
    worktreePath: string,
    next: (state: DebugSessionState) => DebugSessionState
  ): void {
    const previous = getState(worktreePath)
    const state = next(previous)
    if (state !== previous) {
      sessions.set(worktreePath, state)
      listeners.forEach((listener) => listener())
    }
  }

  const resetThread = (state: DebugSessionState, threadId: number | null): DebugSessionState => ({
    ...state,
    selectedThreadId: threadId,
    frames: [],
    selectedFrameId: null,
    selectionEpoch: state.selectionEpoch + 1
  })

  function ingestSnapshot(snapshot: DebugSnapshot): void {
    const before = getState(snapshot.worktreePath).stopSeq
    update(snapshot.worktreePath, (state) => {
      if (state.snapshot && snapshot.seq <= state.snapshot.seq) {
        return state
      }
      const next = { ...state, snapshot }
      const stopped = snapshot.stopped
      if (!stopped) {
        return state.selectedThreadId === null ? next : resetThread(next, null)
      }
      next.stopSeq = snapshot.seq
      // Another thread's stop selects it; a same-thread stop keeps the user's pick when it is still on the stack.
      return state.snapshot?.stopped?.threadId === stopped.threadId
        ? next
        : resetThread(next, stopped.threadId)
    })
    if (getState(snapshot.worktreePath).stopSeq !== before) {
      void loadBoundFrames(snapshot.worktreePath)
    }
  }

  function ingestOutput(event: DebugOutputEvent): void {
    update(event.worktreePath, (state) => {
      if (event.seq <= state.outputSeq) {
        return state
      }
      const line = {
        seq: event.seq,
        ts: event.ts,
        category: event.category,
        text: event.text
      }
      const lines = [...state.console, line]
      return { ...state, console: lines.slice(-DEBUG_CONSOLE_LINE_CAP), outputSeq: event.seq }
    })
  }

  function selectThread(worktreePath: string, threadId: number): void {
    const before = getState(worktreePath)
    update(worktreePath, (state) =>
      state.selectedThreadId === threadId ? state : resetThread(state, threadId)
    )
    if (getState(worktreePath) !== before) {
      void loadBoundFrames(worktreePath)
    }
  }

  function selectFrame(worktreePath: string, frameId: number): void {
    update(worktreePath, (state) =>
      state.selectedFrameId === frameId ? state : { ...state, selectedFrameId: frameId }
    )
  }

  /** Defaults the frame to the top one unless the current pick is still on the stack. */
  function setFrames(
    worktreePath: string,
    threadId: number,
    frames: DebugStackFrameWire[],
    epoch = getState(worktreePath).selectionEpoch
  ): void {
    update(worktreePath, (state) => {
      if (state.selectedThreadId !== threadId || state.selectionEpoch !== epoch) {
        return state
      }
      const kept = frames.some((frame) => frame.id === state.selectedFrameId)
      return {
        ...state,
        frames,
        selectedFrameId: kept ? state.selectedFrameId : (frames[0]?.id ?? null)
      }
    })
  }

  /** Loads the selected thread's stack; worktreePath must be core's path for this session. */
  async function loadFrames(target: DebugWorktree): Promise<void> {
    const { selectedThreadId: threadId, selectionEpoch: epoch } = getState(target.worktreePath)
    if (threadId === null) {
      return
    }
    const result = await client.stackTrace({ ...target, threadId })
    if (result.ok) {
      setFrames(target.worktreePath, threadId, result.value.stackFrames, epoch)
    }
  }

  async function loadBoundFrames(worktreePath: string): Promise<void> {
    const repoId = repos.get(worktreePath)
    if (repoId !== undefined) {
      await loadFrames({ repoId, worktreePath })
    }
  }

  /** Binds core's path to its repo; a stopped session without frames loads them now. */
  function bindRepo(worktreePath: string, repoId: string): void {
    const known = repos.get(worktreePath) === repoId
    repos.set(worktreePath, repoId)
    const state = getState(worktreePath)
    if (!known && state.selectedThreadId !== null && state.frames.length === 0) {
      void loadFrames({ repoId, worktreePath })
    }
  }

  function selectConfiguration(worktreePath: string, configName: string | null): void {
    update(worktreePath, (state) =>
      state.configName === configName ? state : { ...state, configName }
    )
  }

  function clearConsole(worktreePath: string): void {
    update(worktreePath, (state) =>
      state.console.length === 0 ? state : { ...state, console: [] }
    )
  }

  /** Attaches to the client's pushes once; later calls are no-ops until disconnected. */
  function connect(): () => void {
    if (!disconnect) {
      const offState = client.onState(ingestSnapshot)
      const offOutput = client.onOutput(ingestOutput)
      disconnect = () => {
        offState()
        offOutput()
        disconnect = null
      }
    }
    return disconnect
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    getState,
    subscribe,
    connect,
    ingestSnapshot,
    ingestOutput,
    selectThread,
    selectFrame,
    setFrames,
    loadFrames,
    bindRepo,
    selectConfiguration,
    clearConsole
  }
}

export const debugSessionStore = createDebugSessionStore(debugClient)

/** worktreePath is the realpath core reported in a snapshot; null reads the empty session. */
export function useDebugSession(
  worktreePath: string | null,
  store: DebugSessionStore = debugSessionStore
): DebugSessionState {
  useEffect(() => {
    store.connect()
  }, [store])
  return useSyncExternalStore(store.subscribe, () =>
    worktreePath === null ? EMPTY_DEBUG_SESSION : store.getState(worktreePath)
  )
}
