import type { RenderRow } from './render-row'
import { makeWorktree } from '../../worktree-card-slot-fixture-seeds'

export function lineageItemRow(id: string, depth: number, lineageCollapsed?: boolean): RenderRow {
  return {
    type: 'item',
    rowKey: id,
    sectionKey: 'all',
    worktree: makeWorktree({ id, name: id, agents: [] }, 0),
    repo: undefined,
    depth,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0,
    lineageCollapsed
  }
}
