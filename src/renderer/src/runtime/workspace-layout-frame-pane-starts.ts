// Status-only start/resume frames update maps without pane trees, preserving mounted views.

import type { AppState } from '@/store/types'
import type { TerminalPaneResumeOutcome, TerminalPaneStart } from '@/store/terminals/terminal-state'
import { paneKeyOf } from '../../../shared/workspace-layout/workspace-layout-model'
import type {
  PublishedPane,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'

type PaneStarts = AppState['terminalPaneStartsByPaneKey']
type ShownByKey = Map<string, ReadonlySet<string>>

/** The pane keys each workspace last showed, per map, so a fact that ended drops from it. */
export type FramePaneFactsShown = { starts: ShownByKey; resumeOutcomes: ShownByKey }

export function framePaneFactsShown(): FramePaneFactsShown {
  return { starts: new Map(), resumeOutcomes: new Map() }
}

type PaneFact<T> = {
  of: (pane: PublishedPane) => T | null
  same: (a: T | undefined, b: T) => boolean
}

const START: PaneFact<TerminalPaneStart> = {
  of: (pane) =>
    pane.status
      ? { status: pane.status, ...(pane.statusReason ? { reason: pane.statusReason } : {}) }
      : null,
  same: (a, b) => a?.status === b.status && a.reason === b.reason
}

const RESUME_OUTCOME: PaneFact<TerminalPaneResumeOutcome> = {
  of: ({ resumeOutcome: outcome, ptyId, ptyGeneration }) =>
    outcome && ptyId
      ? { ptyId, ...(ptyGeneration !== undefined ? { ptyGeneration } : {}), outcome }
      : null,
  same: (a, b) =>
    a?.ptyId === b.ptyId && a.ptyGeneration === b.ptyGeneration && a.outcome === b.outcome
}

function factsOf<T>(
  layout: PublishedWorkspaceLayout | undefined,
  fact: PaneFact<T>
): Map<string, T> {
  const facts = new Map<string, T>()
  for (const tab of layout?.tabs ?? []) {
    for (const pane of tab.terminal?.panes ?? []) {
      const found = fact.of(pane)
      if (found) {
        facts.set(paneKeyOf(tab.entityId, pane.leafId), found)
      }
    }
  }
  return facts
}

function paneFactsWithFrames<T>(
  current: Record<string, T>,
  keys: Iterable<string>,
  frames: Readonly<Record<string, PublishedWorkspaceLayout | undefined>>,
  shownByKey: ShownByKey,
  fact: PaneFact<T>
): Record<string, T> {
  let next = current
  const write = (): Record<string, T> => (next === current ? { ...current } : next)
  for (const key of keys) {
    const now = factsOf(frames[key], fact)
    for (const paneKey of shownByKey.get(key) ?? []) {
      if (!now.has(paneKey) && paneKey in next) {
        next = write()
        delete next[paneKey]
      }
    }
    for (const [paneKey, found] of now) {
      if (!fact.same(next[paneKey], found)) {
        next = write()
        next[paneKey] = found
      }
    }
    if (now.size > 0) {
      shownByKey.set(key, new Set(now.keys()))
    } else {
      shownByKey.delete(key)
    }
  }
  return next
}

/** Return current on no-op; update shownByKey in place so ended/bound/removed starts leave the map. */
export function paneStartsWithFrames(
  current: PaneStarts,
  keys: Iterable<string>,
  frames: Readonly<Record<string, PublishedWorkspaceLayout | undefined>>,
  shownByKey: ShownByKey
): PaneStarts {
  return paneFactsWithFrames(current, keys, frames, shownByKey, START)
}

/** Shows the starts of the `changed` workspaces, and drops those of workspaces main stopped sending. */
export function showFramePaneStarts(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  changed: readonly string[],
  cache: Readonly<Record<string, PublishedWorkspaceLayout | undefined>>,
  shown: FramePaneFactsShown
): void {
  const state = store.getState()
  const keysOf = (shownByKey: ShownByKey): string[] => [
    ...changed,
    ...[...shownByKey.keys()].filter((key) => !(key in cache))
  ]
  const starts = state.terminalPaneStartsByPaneKey
  const nextStarts = paneStartsWithFrames(starts, keysOf(shown.starts), cache, shown.starts)
  const outcomes = state.terminalPaneResumeOutcomesByPaneKey
  const nextOutcomes = paneFactsWithFrames(
    outcomes,
    keysOf(shown.resumeOutcomes),
    cache,
    shown.resumeOutcomes,
    RESUME_OUTCOME
  )
  if (nextStarts !== starts || nextOutcomes !== outcomes) {
    store.setState({
      ...(nextStarts !== starts ? { terminalPaneStartsByPaneKey: nextStarts } : {}),
      ...(nextOutcomes !== outcomes ? { terminalPaneResumeOutcomesByPaneKey: nextOutcomes } : {})
    })
  }
}
