import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import WorktreeCard from './workspace-card/surface/WorktreeCard'
import * as agentExpansion from './workspace-card/activity/worktree-card-agents-expansion-state'
import * as rows from './worktree-list/rows/indentation'
import {
  MINUTE,
  makeWorktree,
  seedWorkspaces,
  type WorkspaceSeed
} from './worktree-card-slot-fixture-seeds'

const SIDEBAR_WIDTH = 320
// Grouped-by-project geometry from getWorktreeCardContentIndent: one tree step plus the project inset.
const TOP_LEVEL_CONTENT_INDENT = 20

const FLAT: WorkspaceSeed[] = [
  {
    id: 'wt-needs',
    name: 'unify-setup-agent-host-review-and-reviewer-retention',
    agents: [
      {
        agentType: 'codex',
        state: 'blocked',
        minutesAgo: 2,
        prompt: 'Run the web typecheck and fix what breaks'
      },
      {
        agentType: 'claude',
        state: 'working',
        minutesAgo: 1,
        toolName: 'Read',
        toolInput: 'agent-host-review.ts'
      },
      {
        agentType: 'gemini',
        state: 'done',
        minutesAgo: 50,
        message: 'Checked the reviewer list'
      }
    ]
  },
  {
    id: 'wt-failed',
    name: 'fix-remote-session-disappears-when-window-unfocused',
    agents: [
      {
        agentType: 'codex',
        state: 'done',
        minutesAgo: 12,
        failed: true,
        prompt: 'Reproduce the unfocused-window session drop',
        message: 'Usage limit reached'
      },
      {
        agentType: 'claude',
        state: 'done',
        minutesAgo: 40,
        message: 'Reproduced on SSH host'
      }
    ]
  },
  {
    id: 'wt-unread',
    name: 'docs-typo-sweep',
    agents: [
      {
        agentType: 'claude',
        state: 'done',
        minutesAgo: 6,
        unread: true,
        message: 'Fixed 14 typos across docs/ and opened PR #36955'
      }
    ]
  },
  {
    id: 'wt-working',
    name: 'sidebar-card-v2',
    agents: [
      {
        agentType: 'claude',
        state: 'working',
        minutesAgo: 4,
        toolName: 'Edit',
        toolInput: 'worktree-card-surface.tsx'
      }
    ]
  },
  {
    id: 'wt-seen',
    name: 'bump-electron-38',
    agents: [
      {
        agentType: 'codex',
        state: 'done',
        minutesAgo: 95,
        message: 'Bumped Electron to 38.2 and updated the lockfile'
      }
    ]
  },
  {
    id: 'wt-manual',
    name: 'release-1.4-notes',
    agents: [],
    manualUnread: true,
    lastActivityMinutesAgo: 27
  },
  { id: 'wt-quiet', name: 'main', agents: [], lastActivityMinutesAgo: 1500 }
]

const NESTED: WorkspaceSeed[] = [
  {
    id: 'wt-parent',
    name: 'onboard-with-chat-ui',
    agents: [
      {
        agentType: 'claude',
        state: 'done',
        minutesAgo: 38,
        message: 'Wired chat onboarding into first run'
      }
    ]
  },
  {
    id: 'wt-child',
    name: 'fix-startup-skill-discovery',
    agents: [
      {
        agentType: 'codex',
        state: 'done',
        minutesAgo: 14,
        unread: true,
        message: 'Moved skill discovery into startup'
      }
    ]
  },
  {
    id: 'wt-grandchild',
    name: 'align-tour-skill-host',
    agents: [
      {
        agentType: 'claude',
        state: 'working',
        minutesAgo: 3,
        toolName: 'Edit',
        toolInput: 'tour-copy.ts'
      }
    ]
  },
  {
    id: 'wt-collapsed-parent',
    name: 'release-train',
    agents: [
      {
        agentType: 'claude',
        state: 'done',
        minutesAgo: 70,
        message: 'Cut the release branch'
      }
    ]
  },
  {
    id: 'wt-collapsed-child',
    name: 'release-hotfix',
    agents: [
      {
        agentType: 'codex',
        state: 'waiting',
        minutesAgo: 5,
        toolName: 'Edit',
        toolInput: 'CHANGELOG.md'
      }
    ]
  }
]

const FOLDER_WORKSPACE = folderWorkspaceToWorktree({
  id: 'design-notes',
  projectGroupId: 'notes',
  name: 'design-notes',
  folderPath: '~/notes/design',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0
})

function SidebarFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="worktree-sidebar flex flex-col gap-0.5 bg-worktree-sidebar py-1.5 text-worktree-sidebar-foreground">
      {children}
    </div>
  )
}

function Card({
  worktree,
  nested = false,
  active = false,
  children,
  childCount = 0,
  collapsed = false,
  descendantIds
}: {
  worktree: Worktree
  nested?: boolean
  active?: boolean
  children?: React.ReactNode
  childCount?: number
  collapsed?: boolean
  descendantIds?: readonly string[]
}): React.JSX.Element {
  return (
    <div className="relative" data-worktree-id={worktree.id}>
      <WorktreeCard
        worktree={worktree}
        repo={undefined}
        isActive={active}
        contentIndent={nested ? 0 : TOP_LEVEL_CONTENT_INDENT}
        flushSurface
        nativeDragEnabled={false}
        lineageChildCount={childCount}
        lineageCollapsed={collapsed}
        lineageDescendantIds={descendantIds}
        lineageChildWorktreeIds={descendantIds}
        lineageChildren={children}
        lineageChildrenStyle={rows.getLineageChildrenInlineStyle(
          rows.LINEAGE_CHILDREN_INLINE_OFFSET
        )}
        onLineageToggle={childCount > 0 ? () => {} : undefined}
      />
    </div>
  )
}

function worktreesFor(seeds: readonly WorkspaceSeed[], now: number): Map<string, Worktree> {
  return new Map(seeds.map((seed) => [seed.id, makeWorktree(seed, now)]))
}

const now = Date.now()
const flatWorktrees = worktreesFor(FLAT, now)
const nestedWorktrees = worktreesFor(NESTED, now)
FOLDER_WORKSPACE.isUnread = false
FOLDER_WORKSPACE.lastActivityAt = now - 9 * MINUTE

function FlatList(): React.JSX.Element {
  return (
    <SidebarFrame>
      {FLAT.map((seed) => (
        <Card
          key={seed.id}
          worktree={flatWorktrees.get(seed.id)!}
          active={seed.id === 'wt-working'}
        />
      ))}
      <Card worktree={FOLDER_WORKSPACE} />
    </SidebarFrame>
  )
}

export const exceptions = defineFixture({
  width: SIDEBAR_WIDTH,
  setup: () => seedWorkspaces(FLAT, now),
  render: () => <FlatList />
})

export const nesting = defineFixture({
  width: SIDEBAR_WIDTH,
  setup: () => seedWorkspaces(NESTED, now),
  render: () => (
    <SidebarFrame>
      <Card
        worktree={nestedWorktrees.get('wt-parent')!}
        childCount={1}
        descendantIds={['wt-child', 'wt-grandchild']}
      >
        <Card
          nested
          worktree={nestedWorktrees.get('wt-child')!}
          childCount={1}
          descendantIds={['wt-grandchild']}
        >
          <Card nested worktree={nestedWorktrees.get('wt-grandchild')!} />
        </Card>
      </Card>
      <Card
        worktree={nestedWorktrees.get('wt-collapsed-parent')!}
        childCount={1}
        collapsed
        descendantIds={['wt-collapsed-child']}
      />
    </SidebarFrame>
  )
})

export const agentsExpanded = defineFixture({
  width: SIDEBAR_WIDTH,
  setup: () => {
    seedWorkspaces(FLAT, now)
    const none = new Set<string>()
    const state = {
      expandedLineageParents: none,
      expandedIdleChildGroups: none,
      compactRootListExpanded: true
    }
    FLAT.forEach((seed) => agentExpansion.seedWorktreeAgentExpansionStateForTests(seed.id, state))
  },
  render: () => <FlatList />
})
