import React from 'react'
import { FolderTree } from 'lucide-react'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { cn } from '@/lib/class-names'
import {
  FIXTURE_REPO,
  makeWorktree,
  seedWorkspaces,
  type WorkspaceSeed
} from '../../worktree-card-slot-fixture-seeds'
import { buildLineageRowProjection } from '../listing/lineage-row-projection'
import type { RenderRow } from '../listing/render-row'
import {
  getProjectGroupHeaderPaddingLeft,
  WORKTREE_SECTION_HEADER_PADDING_LEFT
} from './indentation'
import { renderWorktreeItemRow, type WorktreeItemRowContext } from './item-row'
import { LineageGuides } from './lineage-guides'

// A project list with a lineage family, a second project, a nested project group, and an empty one.
const TREE: { seed: WorkspaceSeed; depth: number; groupDepth: number; children?: string[] }[] = [
  {
    depth: 0,
    groupDepth: 0,
    seed: { id: 'wt-root', name: 'sidebar-redesign', agents: [] },
    children: ['wt-mid', 'wt-sib']
  },
  {
    depth: 1,
    groupDepth: 0,
    seed: {
      id: 'wt-mid',
      name: 'new-worktree-flow',
      agents: [{ agentType: 'claude', state: 'working', minutesAgo: 1, toolName: 'Read' }]
    },
    children: ['wt-a']
  },
  {
    depth: 2,
    groupDepth: 0,
    seed: {
      id: 'wt-a',
      name: 'add-experiment-flag',
      agents: [{ agentType: 'codex', state: 'done', minutesAgo: 12, message: 'Done' }]
    }
  },
  { depth: 1, groupDepth: 0, seed: { id: 'wt-sib', name: 'sidebar-docs', agents: [] } },
  { depth: 0, groupDepth: 0, seed: { id: 'wt-solo', name: 'unrelated-workspace', agents: [] } },
  { depth: 0, groupDepth: 0, seed: { id: 'wt-api-y', name: 'api-y', agents: [] } },
  { depth: 0, groupDepth: 0, seed: { id: 'wt-api-main', name: 'api-main', agents: [] } },
  { depth: 0, groupDepth: 1, seed: { id: 'wt-lab-main', name: 'lab-main', agents: [] } }
]

const now = Date.now()
const worktrees = new Map<string, Worktree>(
  TREE.map(({ seed }) => [seed.id, makeWorktree(seed, now)])
)

function header(key: string, label: string, depth: number, projectGroup = false): GroupHeaderRow {
  return {
    type: 'header',
    key,
    label,
    count: 2,
    icon: { kind: 'project' },
    projectGroupDepth: depth,
    ...(projectGroup
      ? { projectGroup: { id: null, name: 'Ungrouped' as const, tabOrder: 0 } }
      : { repo: FIXTURE_REPO })
  }
}

const rows: RenderRow[] = [
  header('project:repo:orca', 'orca', 0),
  ...TREE.slice(0, 5).map(({ seed, depth, groupDepth, children }): RenderRow => ({
    type: 'item',
    rowKey: seed.id,
    sectionKey: 'project:repo:orca',
    worktree: worktrees.get(seed.id)!,
    repo: undefined,
    depth,
    groupDepth,
    isLastLineageChild: false,
    lineageChildCount: children?.length ?? 0,
    lineageChildWorktreeIds: children,
    lineageGroupKey: children ? seed.id : undefined,
    lineageCollapsed: false
  })),
  header('project:repo:api', 'api', 0),
  ...TREE.slice(5, 7).map(({ seed }): RenderRow => ({
    type: 'item',
    rowKey: seed.id,
    sectionKey: 'project:repo:api',
    worktree: worktrees.get(seed.id)!,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  })),
  header('project-group:pg-work', 'Work', 0, true),
  header('project:repo:lab', 'lab', 1),
  ...TREE.slice(7).map(({ seed }): RenderRow => ({
    type: 'item',
    rowKey: seed.id,
    sectionKey: 'project:repo:lab',
    worktree: worktrees.get(seed.id)!,
    repo: undefined,
    depth: 0,
    groupDepth: 1,
    isLastLineageChild: false,
    lineageChildCount: 0
  })),
  header('project:repo:empty', 'empty', 0)
]

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

// Why: mirrors SectionHeader's geometry (height, padding, icon box, label) without its action context.
function SectionHeaderPreview({ row }: { row: GroupHeaderRow }): React.JSX.Element {
  const paddingLeft =
    row.repo !== undefined || row.projectGroup !== undefined
      ? getProjectGroupHeaderPaddingLeft(row.projectGroupDepth ?? 0)
      : WORKTREE_SECTION_HEADER_PADDING_LEFT
  return (
    <div className="flex h-7 w-full items-center gap-1.5 pr-2" style={{ paddingLeft }}>
      <div className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground">
        <FolderTree className="size-3" />
      </div>
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-4">{row.label}</div>
    </div>
  )
}

function Tree({ newCardStyle }: { newCardStyle: boolean }): React.JSX.Element {
  const projection = buildLineageRowProjection(rows, 'repo', newCardStyle)
  return (
    <div className="bg-worktree-sidebar py-1.5 text-worktree-sidebar-foreground">
      {rows.map((row, index) => {
        if (row.type === 'header') {
          return (
            <div key={row.key} className={cn(index > 0 && 'pt-1')}>
              <SectionHeaderPreview row={row} />
            </div>
          )
        }
        if (row.type !== 'item') {
          return null
        }
        const frame = projection.frames[index]
        return (
          <div
            key={row.rowKey}
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
            <div className="relative">{renderWorktreeItemRow(ctx, row, frame)}</div>
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
