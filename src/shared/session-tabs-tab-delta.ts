// Per-stream tab-list delta for `session.tabs.subscribe` / `subscribeAll`.
//
// A capable client gets every frame for a worktree stamped with `tabsRevision`. An `updated` frame
// may then replace `tabs` with `tabsDelta`: each entry is either the index of an identical tab in
// the previous frame for that worktree on this stream, or the tab itself. Everything else in the
// frame is sent as before. A client that never advertised the capability never sees either field.
import { SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY } from './session-tabs-runtime-capabilities'

export type SessionTabsTabDeltaRef = number | Record<string, unknown>

export type SessionTabsTabDelta = {
  baseRevision: number
  tabs: SessionTabsTabDeltaRef[]
}

type TabsFrame = { worktree: string; tabs: readonly unknown[]; removed?: true }

type SentTabs = { revision: number; tabJson: string[]; indexByJson: Map<string, number> }

export type SessionTabsTabDeltaEncoder = {
  /** A frame the client must take whole (initial snapshot, census entry). */
  full: <TFrame extends TabsFrame>(frame: TFrame) => TFrame | (TFrame & { tabsRevision: number })
  /** A change frame; sent as a delta when it shares tabs with the previous one. */
  update: <TFrame extends TabsFrame>(
    frame: TFrame
  ) =>
    | TFrame
    | (TFrame & { tabsRevision: number })
    | (Omit<TFrame, 'tabs'> & { tabsRevision: number; tabsDelta: SessionTabsTabDelta })
}

export function clientAcceptsSessionTabsTabDelta(
  clientCapabilities: readonly string[] | undefined
): boolean {
  return clientCapabilities?.includes(SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY) === true
}

export function createSessionTabsTabDeltaEncoder(
  clientCapabilities: readonly string[] | undefined
): SessionTabsTabDeltaEncoder {
  if (!clientAcceptsSessionTabsTabDelta(clientCapabilities)) {
    return { full: (frame) => frame, update: (frame) => frame }
  }
  const sentByWorktree = new Map<string, SentTabs>()
  const record = (worktree: string, tabJson: string[]): number => {
    const revision = (sentByWorktree.get(worktree)?.revision ?? 0) + 1
    const indexByJson = new Map<string, number>()
    tabJson.forEach((json, index) => {
      if (!indexByJson.has(json)) {
        indexByJson.set(json, index)
      }
    })
    sentByWorktree.set(worktree, { revision, tabJson, indexByJson })
    return revision
  }
  const full = <TFrame extends TabsFrame>(
    frame: TFrame
  ): TFrame | (TFrame & { tabsRevision: number }) => {
    if (frame.removed === true) {
      sentByWorktree.delete(frame.worktree)
      return frame
    }
    const tabsRevision = record(
      frame.worktree,
      frame.tabs.map((tab) => JSON.stringify(tab))
    )
    return { ...frame, tabsRevision }
  }
  return {
    full,
    update: (frame) => {
      const previous = sentByWorktree.get(frame.worktree)
      const tabs = frame.tabs.filter(isRecord)
      if (frame.removed === true || !previous || tabs.length !== frame.tabs.length) {
        return full(frame)
      }
      const tabJson = tabs.map((tab) => JSON.stringify(tab))
      let reused = 0
      const refs = tabs.map((tab, index): SessionTabsTabDeltaRef => {
        const json = tabJson[index] ?? ''
        const baseIndex = previous.tabJson[index] === json ? index : previous.indexByJson.get(json)
        if (baseIndex === undefined) {
          return tab
        }
        reused += 1
        return baseIndex
      })
      if (reused === 0) {
        return full(frame)
      }
      const baseRevision = previous.revision
      const tabsRevision = record(frame.worktree, tabJson)
      const { tabs: _tabs, ...rest } = frame
      return { ...rest, tabsRevision, tabsDelta: { baseRevision, tabs: refs } }
    }
  }
}

export type SessionTabsTabDeltaDecodeResult = { ok: true; result: unknown } | { ok: false }

/**
 * Client side of one stream: restores each frame to exactly what a legacy host would have sent.
 * Fails (rather than guessing) when a delta's base is not the last frame this stream delivered.
 */
export function createSessionTabsTabDeltaDecoder(): {
  decode: (result: unknown) => SessionTabsTabDeltaDecodeResult
} {
  const tabsByWorktree = new Map<string, { revision: number; tabs: unknown[] }>()
  const restoreEntry = (entry: Record<string, unknown>): Record<string, unknown> | null => {
    const { tabsRevision, tabsDelta, ...frame } = entry
    const worktree = frame.worktree
    if (typeof worktree !== 'string') {
      return tabsDelta === undefined ? entry : null
    }
    if (frame.removed === true) {
      tabsByWorktree.delete(worktree)
      return tabsDelta === undefined ? frame : null
    }
    if (tabsDelta !== undefined) {
      const base = tabsByWorktree.get(worktree)
      if (
        !base ||
        typeof tabsRevision !== 'number' ||
        !isRecord(tabsDelta) ||
        tabsDelta.baseRevision !== base.revision ||
        !Array.isArray(tabsDelta.tabs)
      ) {
        return null
      }
      const tabs: unknown[] = []
      for (const ref of tabsDelta.tabs) {
        if (typeof ref === 'number') {
          if (!Number.isInteger(ref) || ref < 0 || ref >= base.tabs.length) {
            return null
          }
          tabs.push(base.tabs[ref])
        } else if (isRecord(ref)) {
          tabs.push(ref)
        } else {
          return null
        }
      }
      tabsByWorktree.set(worktree, { revision: tabsRevision, tabs })
      return { ...frame, tabs }
    }
    if (typeof tabsRevision === 'number' && Array.isArray(frame.tabs)) {
      tabsByWorktree.set(worktree, { revision: tabsRevision, tabs: frame.tabs })
      return frame
    }
    // A host without the delta never references this frame, so nothing to remember.
    tabsByWorktree.delete(worktree)
    return tabsRevision === undefined ? entry : frame
  }
  return {
    decode: (result) => {
      if (!isRecord(result)) {
        return { ok: true, result }
      }
      if (result.type === 'snapshots' && Array.isArray(result.snapshots)) {
        // Why: a census replaces the stream's whole inventory, so no older base may survive it.
        tabsByWorktree.clear()
        const snapshots: unknown[] = []
        for (const snapshot of result.snapshots) {
          const restored = isRecord(snapshot) ? restoreEntry(snapshot) : snapshot
          if (restored === null) {
            return { ok: false }
          }
          snapshots.push(restored)
        }
        return { ok: true, result: { ...result, snapshots } }
      }
      if (result.type !== 'snapshot' && result.type !== 'updated') {
        return { ok: true, result }
      }
      const restored = restoreEntry(result)
      return restored === null ? { ok: false } : { ok: true, result: restored }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
