import React from 'react'
import { useAppStore } from '@/store'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import * as rows from '../../worktree-list/rows/indentation'
import {
  FIXTURE_REPO,
  MINUTE,
  makeWorktree,
  seedWorkspaces,
  type WorkspaceSeed
} from '../../worktree-card-slot-fixture-seeds'
import WorktreeCard from './WorktreeCard'

// Title-line icons (link, automation, PR count) must share one right-aligned column at every
// depth and title length, beside the time.
const now = Date.now()
const SEEDS: WorkspaceSeed[] = [
  { id: 'ti-parent', name: 'tidy-settings-layout', agents: [], lastActivityMinutesAgo: 9 },
  { id: 'ti-child', name: 'sample-child-workspace', agents: [], lastActivityMinutesAgo: 9 },
  { id: 'ti-grandchild', name: 'every-icon-at-depth-two', agents: [], lastActivityMinutesAgo: 9 },
  { id: 'ti-detached', name: 'detached-review', agents: [], lastActivityMinutesAgo: 9 },
  {
    id: 'ti-long',
    name: 'nightly-dependency-audit-for-every-sample-package',
    agents: [],
    lastActivityMinutesAgo: 12
  },
  { id: 'ti-prs', name: 'compare-two-plans', agents: [], lastActivityMinutesAgo: 16 },
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `ti-prs-child-${i}`,
    name: `sample-task-${i + 1}`,
    agents: [],
    lastActivityMinutesAgo: 600 + i * 60
  })),
  { id: 'ti-plain', name: 'short', agents: [], lastActivityMinutesAgo: 14 * 60 },
  // Status pills widen the time slot, so these rows' icons sit just left of the pill instead.
  {
    id: 'ti-needs',
    name: 'needs-an-answer',
    agents: [{ agentType: 'codex', state: 'blocked', minutesAgo: 2, prompt: 'Pick a plan' }],
    lastActivityMinutesAgo: 2
  },
  {
    id: 'ti-failed',
    name: 'failed-run',
    agents: [
      {
        agentType: 'claude',
        state: 'done',
        minutesAgo: 5,
        failed: true,
        prompt: 'Run the suite',
        message: 'Usage limit reached'
      }
    ],
    lastActivityMinutesAgo: 5
  },
  { id: 'ti-offline', name: 'remote-host-work', agents: [], lastActivityMinutesAgo: 30 },
  { id: 'ti-quiet', name: 'no-status-pill', agents: [], lastActivityMinutesAgo: 9 }
]
// No saved SSH state reads as disconnected, which draws the offline label.
const OFFLINE_REPO = { ...FIXTURE_REPO, id: 'repo-remote', connectionId: 'ssh-sample-host' }
const CHILD_IDS = SEEDS.filter((seed) => seed.id.startsWith('ti-prs-child-')).map((s) => s.id)

const pr = (number: number) => ({
  provider: 'github' as const,
  type: 'pr' as const,
  number,
  url: `https://github.com/example/sample/pull/${number}`
})

const automationProvenance: Worktree['automationProvenance'] = {
  kind: 'created-by-automation',
  automationId: 'sample-automation',
  automationNameSnapshot: 'Nightly audit',
  automationRunId: 'sample-run',
  automationRunTitleSnapshot: 'Nightly audit',
  createdAt: now - 12 * MINUTE,
  executionTargetType: 'local',
  executionTargetId: 'local',
  projectId: FIXTURE_REPO.id
}

function decorate(worktree: Worktree): Worktree {
  switch (worktree.id) {
    case 'ti-parent':
    case 'ti-child':
    case 'ti-needs':
    case 'ti-quiet':
      return { ...worktree, linkedItems: [pr(101)] }
    case 'ti-failed':
      return { ...worktree, automationProvenance }
    case 'ti-offline':
      return { ...worktree, repoId: OFFLINE_REPO.id, linkedItems: [pr(501), pr(502)] }
    case 'ti-grandchild':
      return { ...worktree, linkedItems: [pr(301), pr(302)], automationProvenance }
    // Detached HEAD fills the details row, so its icon moves there instead of the title line.
    case 'ti-detached':
      return { ...worktree, branch: '', head: 'f00dcafe1234', linkedItems: [pr(401)] }
    case 'ti-long':
      return { ...worktree, automationProvenance }
    case 'ti-prs':
      return { ...worktree, linkedItems: [pr(201), pr(202)] }
    default:
      return worktree
  }
}

const worktrees = new Map(SEEDS.map((seed) => [seed.id, decorate(makeWorktree(seed, now))]))

function Card({
  id,
  nested = false,
  descendantIds,
  collapsed = false,
  children
}: {
  id: string
  nested?: boolean
  descendantIds?: readonly string[]
  collapsed?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const worktree = worktrees.get(id)!
  const childCount = collapsed ? (descendantIds?.length ?? 0) : React.Children.count(children)
  return (
    <WorktreeCard
      worktree={worktree}
      repo={worktree.repoId === OFFLINE_REPO.id ? OFFLINE_REPO : FIXTURE_REPO}
      hideRepoBadge
      isActive={false}
      // Grouped-by-project geometry: one tree step plus the project inset.
      contentIndent={nested ? 0 : 20}
      flushSurface
      nativeDragEnabled={false}
      lineageChildCount={childCount}
      lineageCollapsed={collapsed}
      lineageDescendantIdentities={descendantIds?.map((d) =>
        composeWorktreeHostIdentity(worktrees.get(d)?.hostId, d)
      )}
      lineageChildWorktreeIds={descendantIds}
      lineageChildren={children}
      lineageChildrenStyle={rows.getLineageChildrenInlineStyle(rows.LINEAGE_CHILDREN_INLINE_OFFSET)}
      onLineageToggle={childCount > 0 ? () => {} : undefined}
    />
  )
}

function setup(): void {
  seedWorkspaces(SEEDS, now)
  useAppStore.setState((state) => ({
    settings: state.settings
      ? { ...state.settings, experimentalNewWorktreeCardStyle: true, worktreeCardDetailsRow: true }
      : null,
    repos: [FIXTURE_REPO, OFFLINE_REPO],
    worktreeCardProperties: ['status', 'pr', 'automation', 'cli', 'comment', 'ports'],
    worktreesByRepo: {
      [FIXTURE_REPO.id]: [...worktrees.values()].filter((w) => w.repoId === FIXTURE_REPO.id),
      [OFFLINE_REPO.id]: [worktrees.get('ti-offline')!]
    }
  }))
}

const Frame = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="flex flex-col gap-0.5 bg-worktree-sidebar py-1.5 text-worktree-sidebar-foreground">
    {children}
  </div>
)

export const statusPills = defineFixture({
  width: 320,
  setup,
  render: () => (
    <Frame>
      <Card id="ti-quiet" />
      <Card id="ti-needs" />
      <Card id="ti-failed" />
      <Card id="ti-offline" />
    </Frame>
  )
})

export const nestedAndLongTitles = defineFixture({
  width: 320,
  setup,
  render: () => (
    <Frame>
      <Card id="ti-parent" descendantIds={['ti-child', 'ti-grandchild']}>
        <Card id="ti-child" nested descendantIds={['ti-grandchild']}>
          <Card id="ti-grandchild" nested />
        </Card>
      </Card>
      <Card id="ti-long" />
      <Card id="ti-prs" descendantIds={CHILD_IDS} collapsed />
      <Card id="ti-plain" />
      <Card id="ti-detached" />
    </Frame>
  )
})

export const narrowSidebar = defineFixture({ ...nestedAndLongTitles, width: 240 })
