import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'

/** Carries the saved scrollback of `leafIds` into a freshly serialized layout. */
export function retainLayoutScrollback(
  layout: TerminalLayoutSnapshot,
  saved: TerminalLayoutSnapshot | undefined,
  leafIds: ReadonlySet<string>
): void {
  for (const key of ['buffersByLeafId', 'scrollbackRefsByLeafId'] as const) {
    const merged = mergeCapturedLeafState({
      prior: saved?.[key],
      fresh: {},
      currentLeafIds: leafIds
    })
    if (Object.keys(merged).length > 0) {
      layout[key] = merged
    }
  }
}

/**
 * Saved titles of still-mounted leaves, overlaid by live pane titles. A live title un-removes its
 * leaf, so `removedTitleLeafIds` is updated in place.
 */
export function mergeLayoutTitlesByLeafId(
  panes: readonly { id: number; leafId: string }[],
  savedTitlesByLeafId: Readonly<Record<string, string>> | undefined,
  paneTitles: Readonly<Record<number, string>>,
  removedTitleLeafIds: Set<string>
): Record<string, string> {
  const titlesByLeafId: Record<string, string> = {}
  for (const pane of panes) {
    const savedTitle = savedTitlesByLeafId?.[pane.leafId]
    if (savedTitle && !removedTitleLeafIds.has(pane.leafId)) {
      titlesByLeafId[pane.leafId] = savedTitle
    }
  }
  for (const pane of panes) {
    const title = paneTitles[pane.id]
    if (title) {
      titlesByLeafId[pane.leafId] = title
      removedTitleLeafIds.delete(pane.leafId)
    }
  }
  return titlesByLeafId
}
