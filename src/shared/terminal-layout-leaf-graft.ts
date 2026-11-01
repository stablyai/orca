import type { TerminalLayoutSnapshot } from './terminal-tab-types'
import {
  insertLeafBeside,
  layoutContainsLeafId,
  type PaneSide
} from './workspace-layout/terminal-pane-tree'

type LeafRecords = Pick<
  TerminalLayoutSnapshot,
  'ptyIdsByLeafId' | 'titlesByLeafId' | 'buffersByLeafId' | 'scrollbackRefsByLeafId'
>

const CARRIED_FIELDS = [
  'titlesByLeafId',
  'buffersByLeafId',
  'scrollbackRefsByLeafId'
] as const satisfies readonly (keyof LeafRecords)[]

/**
 * `target` with `leafId` split in beside `targetLeafId` on `side`, active and uncollapsed. The
 * leaf's title, buffer and scrollback ref come from `source`; its binding is the explicit `ptyId`,
 * because a stale layout copy may still name a PTY the pane has left. Null when the target lacks
 * `targetLeafId` or already holds `leafId`. Main and the renderer graft with this one function.
 */
export function graftLeafBeside(args: {
  target: TerminalLayoutSnapshot
  source: TerminalLayoutSnapshot | undefined
  leafId: string
  targetLeafId: string
  side: PaneSide
  ptyId: string | null
  /** Title for the leaf when `source` records none, e.g. the source tab's custom title. */
  fallbackTitle?: string | null
}): TerminalLayoutSnapshot | null {
  const { target, source, leafId, targetLeafId, side, ptyId, fallbackTitle } = args
  if (
    !target.root ||
    !layoutContainsLeafId(target.root, targetLeafId) ||
    layoutContainsLeafId(target.root, leafId)
  ) {
    return null
  }
  const carried: LeafRecords = {}
  for (const field of CARRIED_FIELDS) {
    const value = source?.[field]?.[leafId]
    if (value !== undefined) {
      carried[field] = { ...target[field], [leafId]: value }
    }
  }
  if (carried.titlesByLeafId === undefined && fallbackTitle) {
    carried.titlesByLeafId = { ...target.titlesByLeafId, [leafId]: fallbackTitle }
  }
  if (ptyId) {
    carried.ptyIdsByLeafId = { ...target.ptyIdsByLeafId, [leafId]: ptyId }
  }
  return {
    ...target,
    root: insertLeafBeside(target.root, targetLeafId, leafId, side),
    activeLeafId: leafId,
    expandedLeafId: null,
    ...carried
  }
}
