import React from 'react'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  FIXTURE_REPO,
  makeWorktree,
  seedWorkspaces,
  type WorkspaceSeed
} from '../../worktree-card-slot-fixture-seeds'
import { buildLineageRowProjection } from '../listing/lineage-row-projection'
import type { RenderRow } from '../listing/render-row'
import { renderWorktreeItemRow, type WorktreeItemRowContext } from './item-row'
import { LineageGuides } from './lineage-guides'

// A nested family like the one users struggle to read: a child that has children of its own.
const TREE: { seed: WorkspaceSeed; depth: number }[] = [
  { depth: 0, seed: { id: 'wt-root', name: 'sidebar-redesign', agents: [] } },
  {
    depth: 1,
    seed: {
      id: 'wt-mid',
      name: 'new-worktree-flow',
      agents: [
        {
          agentType: 'claude',
          state: 'working',
          minutesAgo: 1,
          toolName: 'Read'
        }
      ]
    }
  },
  {
    depth: 2,
    seed: {
      id: 'wt-a',
      name: 'add-experiment-flag',
      agents: [{ agentType: 'codex', state: 'done', minutesAgo: 12, message: 'Done' }]
    }
  },
  { depth: 3, seed: { id: 'wt-a1', name: 'flag-telemetry', agents: [] } },
  { depth: 2, seed: { id: 'wt-b', name: 'fix-review-panel', agents: [] } },
  { depth: 2, seed: { id: 'wt-c', name: 'fix-agent-status', agents: [] } },
  { depth: 1, seed: { id: 'wt-sib', name: 'sidebar-docs', agents: [] } },
  {
    depth: 0,
    seed: { id: 'wt-solo', name: 'unrelated-workspace', agents: [] }
  }
]

const now = Date.now()
const worktrees = new Map<string, Worktree>(
  TREE.map(({ seed }) => [seed.id, makeWorktree(seed, now)])
)

function childIds(index: number): string[] {
  const ids: string[] = []
  for (let i = index + 1; i < TREE.length && TREE[i].depth > TREE[index].depth; i++) {
    if (TREE[i].depth === TREE[index].depth + 1) {
      ids.push(TREE[i].seed.id)
    }
  }
  return ids
}

const rows: RenderRow[] = TREE.map(({ seed, depth }, index) => {
  const children = childIds(index)
  return {
    type: 'item',
    rowKey: seed.id,
    sectionKey: 'repo-orca',
    worktree: worktrees.get(seed.id)!,
    repo: FIXTURE_REPO,
    depth,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: children.length,
    lineageChildWorktreeIds: children,
    lineageGroupKey: children.length > 0 ? seed.id : undefined,
    lineageCollapsed: false
  }
})

const noop = (): void => {}
const ctx: WorktreeItemRowContext = {
  settings: getDefaultSettings('/home/fixture'),
  groupBy: 'repo',
  groupKeyByRowKey: new Map(),
  groupIndexByRowKey: new Map(),
  agentSendTargetWorktreeId: null,
  worktreeDragState: {
    draggingWorktreeId: null,
    sourceGroupKey: null,
    dropIndex: null,
    dropIndicatorY: null,
    previewOffsetsByWorktreeId: new Map(),
    pointerY: null,
    lineageDropTargetIdentity: null
  },
  nativeLineageDropTargetIdentity: null,
  activeWorktreeId: null,
  activeWorkspaceExecutionHostId: null,
  currentWorktreeId: null,
  highlightedRevealRowKey: null,
  selectedWorktreeIds: new Set(),
  selectedWorktrees: [],
  getActiveSurfaceVariant: () => 'primary',
  getLineageToggleHandler: () => noop,
  onSelectionGesture: () => false,
  onContextMenuSelect: () => [],
  onImmediateActivate: noop,
  onRowClickCapture: noop,
  onRowPointerDown: noop,
  onCardDragStart: noop,
  onCardDragEnd: noop
}

function Tree({ newCardStyle }: { newCardStyle: boolean }): React.JSX.Element {
  const projection = buildLineageRowProjection(rows, 'repo', newCardStyle)
  return (
    <div className="bg-worktree-sidebar py-1.5 text-worktree-sidebar-foreground">
      {rows.map((row, index) => {
        const frame = projection.frames[index]
        return (
          <div
            key={row.type === 'item' ? row.rowKey : undefined}
            className="relative"
            data-worktree-lineage-row={frame.guides ? '' : undefined}
            style={{
              paddingTop: frame.before,
              paddingBottom: frame.closing + frame.after
            }}
          >
            {frame.guides && (
              <LineageGuides guides={frame.guides} before={frame.before} hidden={false} />
            )}
            <div className="relative">
              {row.type === 'item' && renderWorktreeItemRow(ctx, row, frame)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function setup(newCardStyle: boolean) {
  return () => {
    seedWorkspaces(
      TREE.map(({ seed }) => seed),
      now
    )
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/fixture'),
        experimentalNewWorktreeCardStyle: newCardStyle
      },
      worktreeCardProperties: ['status', 'branch', 'inline-agents']
    })
  }
}

export const newCardStyle = defineFixture({
  width: 300,
  setup: setup(true),
  render: () => <Tree newCardStyle />
})

export const legacyCardStyle = defineFixture({
  width: 300,
  setup: setup(false),
  render: () => <Tree newCardStyle={false} />
})
