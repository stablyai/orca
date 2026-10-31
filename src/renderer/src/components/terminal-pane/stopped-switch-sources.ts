import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type {
  StoppedSwitchSource,
  StoppedSwitchSourceFact
} from '../../../../shared/stopped-switch-source'
import { isWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

/**
 * A pane whose process a switch stopped for a replace, and main's word that no replace removed it.
 * Both are held per leaf only while that leaf still shows that process, so a closed, rebound or
 * successor pane drops them; module memory, so nothing outlives the window. The stopped fact is
 * kept apart from the mounted pane, so a pane parked before or after its exit takes the settlement
 * when it is shown again.
 */
type StoppedPane = { ptyId: string; incarnationId: string | null; exitCode: number }
type Entry = {
  tabId: string
  leafId: string
  stopped?: StoppedPane
  notice?: StoppedSwitchSource
  watcher?: (notice: StoppedSwitchSource) => void
}

const entries = new Map<string, Entry>()
let unsubscribeStore: (() => void) | null = null
let reconcileCount = 0

const keyOf = (tabId: string, leafId: string): string => `${tabId}:${leafId}`

function entryFor(tabId: string, leafId: string): Entry {
  const key = keyOf(tabId, leafId)
  let entry = entries.get(key)
  if (!entry) {
    entry = { tabId, leafId }
    entries.set(key, entry)
  }
  return entry
}

function shownPtyId(state: AppState, tabId: string, leafId: string): string | undefined {
  return state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
}

/** A switch that put a chat in this tab's slot settles only once that chat is here: by then the
 *  replace's own pass has closed the tab, so a successful switch never shows the exited state. */
function replaceSettled(state: AppState, notice: StoppedSwitchSource): boolean {
  const { replacedBySessionId } = notice
  return (
    !replacedBySessionId ||
    (state.unifiedTabsByWorktree[notice.worktreeId] ?? []).some(
      (tab) => tab.contentType === 'agent-session' && tab.entityId === replacedBySessionId
    )
  )
}

function settles(state: AppState, entry: Entry): boolean {
  const { stopped, notice } = entry
  return Boolean(
    stopped &&
    notice &&
    notice.ptyId === stopped.ptyId &&
    !(
      stopped.incarnationId &&
      notice.incarnationId &&
      notice.incarnationId !== stopped.incarnationId
    ) &&
    replaceSettled(state, notice)
  )
}

function reconcile(): void {
  reconcileCount += 1
  const state = useAppStore.getState()
  for (const [key, entry] of entries) {
    const shown = shownPtyId(state, entry.tabId, entry.leafId)
    if (entry.stopped && entry.stopped.ptyId !== shown) {
      entry.stopped = undefined
    }
    if (entry.notice && entry.notice.ptyId !== shown) {
      entry.notice = undefined
    }
    if (!entry.stopped && !entry.notice) {
      entries.delete(key)
    } else if (entry.watcher && entry.notice && settles(state, entry)) {
      const settle = entry.watcher
      entries.delete(key)
      settle(entry.notice)
    }
  }
  if (entries.size === 0) {
    unsubscribeStore?.()
    unsubscribeStore = null
  }
}

let reconcileQueued = false
// After the store write that brought the chat: the same pass closes a replaced tab first.
function scheduleReconcile(): void {
  if (reconcileQueued) {
    return
  }
  reconcileQueued = true
  queueMicrotask(() => {
    reconcileQueued = false
    reconcile()
  })
}

/** Only writes to the slices an entry reads can change its outcome; every other write is ignored. */
function onStoreWrite(state: AppState, prev: AppState): void {
  for (const entry of entries.values()) {
    if (
      state.terminalLayoutsByTabId[entry.tabId] !== prev.terminalLayoutsByTabId[entry.tabId] ||
      (entry.notice?.replacedBySessionId &&
        state.unifiedTabsByWorktree[entry.notice.worktreeId] !==
          prev.unifiedTabsByWorktree[entry.notice.worktreeId])
    ) {
      scheduleReconcile()
      return
    }
  }
}

function track(): void {
  unsubscribeStore ??= useAppStore.subscribe(onStoreWrite)
  scheduleReconcile()
}

export function noteStoppedSwitchSource(notice: StoppedSwitchSource): void {
  if (shownPtyId(useAppStore.getState(), notice.tabId, notice.leafId) !== notice.ptyId) {
    return
  }
  entryFor(notice.tabId, notice.leafId).notice = notice
  track()
}

/** A terminal row of a frame this window applied, carrying main's stopped fact. */
export type FrameStoppedSwitchSourceRow = {
  parentTabId: string
  leafId: string
  stoppedSwitchSource: StoppedSwitchSourceFact
}

/**
 * Main's fact on a row of a frame this window applied; its notice only wakes. Main repeats the
 * fact on every frame while it stands, so the one already held for that process costs nothing and
 * is kept: its held screen arrives only in the stream's first frame naming the process.
 */
export function noteFrameStoppedSwitchSource(
  worktreeId: string,
  row: FrameStoppedSwitchSourceRow
): void {
  const fact = row.stoppedSwitchSource
  const held = entries.get(keyOf(row.parentTabId, row.leafId))?.notice
  if (
    held?.switched?.agent === fact.agent &&
    !held.replacedBySessionId &&
    held.ptyId === fact.ptyId &&
    held.incarnationId === fact.incarnationId
  ) {
    return
  }
  noteStoppedSwitchSource({
    worktreeId,
    tabId: row.parentTabId,
    leafId: row.leafId,
    ptyId: fact.ptyId,
    incarnationId: fact.incarnationId,
    switched: { agent: fact.agent, ...(fact.screen ? { screen: fact.screen } : {}) }
  })
}

/**
 * A pane that kept a stopped process's screen for a replace records that fact and watches for
 * main's settlement. The callback runs once, for this exact process; the returned function stops
 * watching but keeps the fact, so the pane takes the settlement when it is shown again.
 */
export function watchStoppedSwitchSource(
  pane: { tabId: string; leafId: string } & StoppedPane,
  settle: (notice: StoppedSwitchSource) => void
): () => void {
  const entry = entryFor(pane.tabId, pane.leafId)
  entry.stopped = { ptyId: pane.ptyId, incarnationId: pane.incarnationId, exitCode: pane.exitCode }
  const watcher = (notice: StoppedSwitchSource): void => settle(notice)
  entry.watcher = watcher
  track()
  return () => {
    if (entry.watcher === watcher) {
      entry.watcher = undefined
    }
  }
}

/**
 * The stopped process a remounting leaf still shows, if a switch stopped it: nothing to reattach.
 * A pane that never saw the exit (never mounted, or parked first) takes it from main's word.
 */
export function readStoppedSwitchSource(
  tabId: string,
  leafId: string,
  ptyId: string
): StoppedPane | null {
  const entry = entries.get(keyOf(tabId, leafId))
  if (entry?.stopped?.ptyId === ptyId) {
    return entry.stopped
  }
  const notice = entry?.notice
  return notice?.switched && notice.ptyId === ptyId
    ? { ptyId, incarnationId: notice.incarnationId ?? null, exitCode: 0 }
    : null
}

/**
 * Main's fact for the process a paired client's leaf shows, from the frame its store holds; that
 * frame also keeps the leaf bound to the stopped process, so nothing here outlives the binding.
 */
export function readMirroredStoppedSwitchSource(
  tabId: string,
  leafId: string,
  ptyId: string
): StoppedSwitchSourceFact | null {
  if (!isWebTerminalSurfaceTabId(tabId) || !isTerminalLeafId(leafId)) {
    return null
  }
  const state = useAppStore.getState()
  return shownPtyId(state, tabId, leafId) === ptyId
    ? (state.agentConversationsByPaneKey[makePaneKey(tabId, leafId)]?.stoppedSwitchSource ?? null)
    : null
}

export function getStoppedSwitchSourceReconcileCountForTests(): number {
  return reconcileCount
}

export function resetStoppedSwitchSourcesForTests(): void {
  entries.clear()
  reconcileCount = 0
  unsubscribeStore?.()
  unsubscribeStore = null
}
