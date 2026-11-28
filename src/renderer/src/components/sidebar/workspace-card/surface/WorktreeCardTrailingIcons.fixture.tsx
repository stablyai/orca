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
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { getWorkspaceReferenceRequest } from '../review/workspace-reference-details'

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
  { id: 'ti-mixed-3', name: 'three-mixed-reviews', agents: [], lastActivityMinutesAgo: 21 },
  {
    id: 'ti-mixed-many',
    name: 'many-reviews-with-a-very-long-workspace-name',
    agents: [],
    lastActivityMinutesAgo: 25
  },
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
// A remote identity lets linked reviews resolve their seeded statuses.
const REPO = {
  ...FIXTURE_REPO,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/example/sample',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/example/sample.git'
  }
}
// No saved SSH state reads as disconnected, which draws the offline label.
const OFFLINE_REPO = { ...REPO, id: 'repo-remote', connectionId: 'ssh-sample-host' }
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
    // Detached HEAD shows as an inline identity icon on the title line alongside trailing icons.
    case 'ti-detached':
      return { ...worktree, branch: '', head: 'f00dcafe1234', linkedItems: [pr(401)] }
    case 'ti-long':
      return { ...worktree, automationProvenance }
    case 'ti-prs':
      return { ...worktree, linkedItems: [pr(201), pr(202)] }
    case 'ti-mixed-3':
      return { ...worktree, linkedItems: [pr(601), pr(602), pr(603)] }
    case 'ti-mixed-many':
      return {
        ...worktree,
        linkedItems: Array.from({ length: 24 }, (_, i) => pr(701 + i))
      }
    default:
      return worktree
  }
}

const worktrees = new Map(SEEDS.map((seed) => [seed.id, decorate(makeWorktree(seed, now))]))

type ReviewSeed = Pick<HostedReviewInfo, 'state' | 'status'>
const MERGED: ReviewSeed = { state: 'merged', status: 'success' }
const FAILING: ReviewSeed = { state: 'open', status: 'failure' }
const RUNNING: ReviewSeed = { state: 'open', status: 'pending' }
const PASSING: ReviewSeed = { state: 'open', status: 'success' }
const CLOSED: ReviewSeed = { state: 'closed', status: 'neutral' }
const DRAFT: ReviewSeed = { state: 'draft', status: 'success' }
const REVIEW_STATES: Record<number, ReviewSeed> = {
  201: MERGED,
  202: FAILING,
  301: PASSING,
  302: RUNNING,
  501: MERGED,
  502: CLOSED,
  601: MERGED,
  602: FAILING,
  603: PASSING,
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [
      701 + i,
      [FAILING, RUNNING, PASSING, DRAFT, MERGED, MERGED, CLOSED, PASSING, MERGED, CLOSED][i % 10]
    ])
  )
}

// Linked-review reads resolve from this cache, so each card shows real per-review statuses.
function seedReviewStates(): void {
  const cache: Record<string, { data: HostedReviewInfo; fetchedAt: number }> = {}
  for (const worktree of worktrees.values()) {
    const repo = worktree.repoId === OFFLINE_REPO.id ? OFFLINE_REPO : REPO
    for (const item of worktree.linkedItems ?? []) {
      const state = REVIEW_STATES[item.number]
      if (!state || item.type === 'issue') {
        continue
      }
      cache[getWorkspaceReferenceRequest(item, worktree, repo).key] = {
        fetchedAt: now,
        data: {
          provider: 'github',
          number: item.number,
          title: `Sample change ${item.number} with a long descriptive title`,
          url: item.url ?? '',
          updatedAt: new Date(now).toISOString(),
          mergeable: 'MERGEABLE',
          ...state
        }
      }
    }
  }
  useAppStore.setState((s) => ({ hostedReviewCache: { ...s.hostedReviewCache, ...cache } }))
}

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
      repo={worktree.repoId === OFFLINE_REPO.id ? OFFLINE_REPO : REPO}
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
  seedReviewStates()
  useAppStore.setState((state) => ({
    settings: state.settings
      ? { ...state.settings, experimentalNewWorktreeCardStyle: true, worktreeCardDetailsRow: true }
      : null,
    repos: [REPO, OFFLINE_REPO],
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
      <Card id="ti-mixed-3" />
      <Card id="ti-mixed-many" />
      <Card id="ti-plain" />
      <Card id="ti-detached" />
    </Frame>
  )
})

export const narrowSidebar = defineFixture({ ...nestedAndLongTitles, width: 240 })

// Keyboard focus on a multi-review glyph opens its peek, as hover does.
export const referencePeek = defineFixture({
  ...nestedAndLongTitles,
  width: 240,
  interact: async (frame) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    const glyphs = frame.querySelectorAll<HTMLElement>('[data-workspace-reference-stack][tabindex]')
    glyphs.item(glyphs.length - 1)?.focus()
  }
})

export const referencePeekWide = defineFixture({ ...referencePeek, width: 320 })
