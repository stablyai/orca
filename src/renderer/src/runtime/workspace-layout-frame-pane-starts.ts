// Main's pane starts, as the window's store shows them: a status-only frame changes this map and no
// pane tree, so the pane's view stays mounted.

import type { AppState } from '@/store/types'
import type { TerminalPaneStart } from '@/store/terminals/terminal-state'
import { paneKeyOf } from '../../../shared/workspace-layout/workspace-layout-model'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'

type PaneStarts = AppState['terminalPaneStartsByPaneKey']

function startsOf(layout: PublishedWorkspaceLayout | undefined): Map<string, TerminalPaneStart> {
  const starts = new Map<string, TerminalPaneStart>()
  for (const tab of layout?.tabs ?? []) {
    for (const pane of tab.terminal?.panes ?? []) {
      if (pane.status) {
        starts.set(paneKeyOf(tab.entityId, pane.leafId), {
          status: pane.status,
          ...(pane.statusReason ? { reason: pane.statusReason } : {})
        })
      }
    }
  }
  return starts
}

const sameStart = (a: TerminalPaneStart | undefined, b: TerminalPaneStart): boolean =>
  a?.status === b.status && a.reason === b.reason

/**
 * `current` with each of `keys`' panes showing what its workspace's frame says, the same object
 * when nothing changed. `shownByKey` holds the pane keys each workspace last showed, so a start
 * that ended (the pane bound, or left) drops from the map; it is updated in place.
 */
export function paneStartsWithFrames(
  current: PaneStarts,
  keys: Iterable<string>,
  frames: Readonly<Record<string, PublishedWorkspaceLayout | undefined>>,
  shownByKey: Map<string, ReadonlySet<string>>
): PaneStarts {
  let next = current
  const write = (): PaneStarts => (next === current ? { ...current } : next)
  for (const key of keys) {
    const now = startsOf(frames[key])
    for (const paneKey of shownByKey.get(key) ?? []) {
      if (!now.has(paneKey) && paneKey in next) {
        next = write()
        delete next[paneKey]
      }
    }
    for (const [paneKey, start] of now) {
      if (!sameStart(next[paneKey], start)) {
        next = write()
        next[paneKey] = start
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

/** Shows the starts of the `changed` workspaces, and drops those of workspaces main stopped sending. */
export function showFramePaneStarts(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  changed: readonly string[],
  cache: Readonly<Record<string, PublishedWorkspaceLayout | undefined>>,
  shownByKey: Map<string, ReadonlySet<string>>
): void {
  const starts = store.getState().terminalPaneStartsByPaneKey
  const gone = [...shownByKey.keys()].filter((key) => !(key in cache))
  const next = paneStartsWithFrames(starts, [...changed, ...gone], cache, shownByKey)
  if (next !== starts) {
    store.setState({ terminalPaneStartsByPaneKey: next })
  }
}
