// @vitest-environment happy-dom

import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import type { Repo } from '../../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../../shared/worktree/card-properties'
import type { WorktreeCardProps } from '../worktree-card-model'

type Mocks = {
  state: Record<string, unknown>
  cacheStartedAt: number | null
  deleteModifier: boolean
}
const mocks = vi.hoisted((): Mocks => ({ state: {}, cacheStartedAt: null, deleteModifier: false }))

vi.mock('@/store', () => {
  const getState = () => mocks.state
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState
    })
  }
})
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <div data-hover-card="">{children}</div>,
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-hover-card-content="">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) =>
    React.isValidElement<Record<string, unknown>>(children) ? (
      React.cloneElement(children, { 'data-hover-card-trigger': '' })
    ) : (
      <>{children}</>
    )
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-tooltip="">{children}</span>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('../use-worktree-activity-status', () => ({ useWorktreeActivityStatus: () => 'active' }))
vi.mock('../use-worktree-sleep-state', () => ({ useIsSleepingWorktree: () => false }))
vi.mock('../CacheTimer', () => ({
  default: ({ startedAt }: { startedAt: number }) => <span data-cache-timer={startedAt} />,
  usePromptCacheCountdownStartedAt: () => mocks.cacheStartedAt
}))
vi.mock('../WorktreeCardAgents', () => ({
  default: ({ className }: { className?: string }) => (
    <div className={className} data-worktree-agents="" />
  )
}))
vi.mock('../WorktreeLineageToggle', () => ({
  WorktreeLineageToggle: ({ count, label }: { count: number; label: string }) => (
    <button type="button" data-lineage-toggle={count}>
      {label}
    </button>
  )
}))
vi.mock('../workspace-delete-quick-action', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWorkspaceDeleteModifierPressed: () => mocks.deleteModifier
}))

const { useWorktreeCardController } = await import('../use-worktree-card-controller')
const { buildWorktreeCardPresentation } = await import('../worktree-card-presentation')
const { WorktreeCardParentContent } = await import('../worktree-card-parent-content')
const { getWorktreeCardFrameGeometry } = await import('../worktree-card-frame-geometry')
const { DEFAULT_WORKSPACE_CARD_TEMPLATE } = await import('./default-workspace-card')
const { renderWorkspaceCardTemplate } = await import('./render-workspace-card-template')

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#999999',
  addedAt: 1
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/feature',
    repoId: 'repo-1',
    path: '/repo/worktrees/feature',
    displayName: 'Card plugins',
    branch: 'refs/heads/feature/card-plugins',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function review(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 456,
    title: 'Card plugins',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/456',
    status: 'failure',
    updatedAt: '2026-11-02T00:00:00.000Z',
    mergeable: 'CONFLICTING',
    ...overrides
  }
}

type Case = {
  worktree?: Partial<Worktree>
  repo?: Partial<Repo> | null
  props?: Partial<WorktreeCardProps>
  state?: Record<string, unknown>
  cardProps?: WorktreeCardProperty[]
  cacheStartedAt?: number
  deleteModifier?: boolean
}

const wt = makeWorktree()
const CASES: Record<string, Case> = {
  plain: {},
  titleOnly: { cardProps: ['status'], worktree: { branch: '' } },
  noStatus: { cardProps: ['issue', 'pr', 'ports', 'inline-agents', 'host'] },
  noInlineAgents: { cardProps: ['status', 'unread', 'pr', 'host'] },
  branchMatchesName: { worktree: { displayName: 'feature/card-plugins' } },
  unread: { worktree: { isUnread: true } },
  main: { worktree: { isMainWorktree: true, branch: 'refs/heads/main' } },
  sparse: { worktree: { isSparse: true, sparseDirectories: ['src', 'docs'] } },
  renameFailed: { worktree: { firstAgentMessageRenameError: 'agent said no' } },
  removalError: { worktree: { removalError: '/repo/worktrees/feature: busy' } },
  detached: { worktree: { branch: '', head: 'deadbeef' } },
  merging: { state: { gitConflictOperationByWorktree: { [wt.id]: 'merge' } } },
  rebasing: { state: { gitConflictOperationByWorktree: { [wt.id]: 'rebase' } } },
  remoteConflict: {
    state: {
      remoteBranchConflictByWorktreeId: {
        [wt.id]: { remote: 'origin', branchName: 'feature/card-plugins' }
      }
    }
  },
  prFailing: {
    worktree: { linkedPR: 456 },
    state: {
      hostedReviewCache: {
        'local::repo-1::feature/card-plugins': { data: review(), fetchedAt: 1 }
      }
    }
  },
  details: {
    worktree: {
      linkedIssue: 12,
      linkedLinearIssue: 'ORC-1',
      comment: 'Waiting on review',
      automationProvenance: {
        kind: 'created-by-automation',
        automationId: 'a1',
        automationNameSnapshot: 'Nightly',
        automationRunId: 'r1',
        automationRunTitleSnapshot: 'Nightly run',
        createdAt: 1,
        executionTargetType: 'local',
        executionTargetId: 'local',
        projectId: 'repo-1'
      }
    }
  },
  twoAttachments: {
    worktree: {
      linkedItems: [
        { type: 'pr', provider: 'github', number: 1, url: 'https://github.com/a/b/pull/1' },
        { type: 'pr', provider: 'github', number: 2, url: 'https://github.com/a/b/pull/2' }
      ]
    }
  },
  cacheTimer: { cacheStartedAt: 1000 },
  deleteQuickAction: { deleteModifier: true },
  ssh: { repo: { connectionId: 'ssh-1' } },
  runtime: { repo: { executionHostId: 'runtime:env-1' } },
  folder: { repo: { kind: 'folder' }, worktree: { branch: '' } },
  folderWithGroups: {
    repo: { kind: 'folder' },
    worktree: { branch: '' },
    state: { projectGroups: [{ id: 'g1' }] }
  },
  noRepo: { repo: null },
  pinned: { props: { inPinnedSection: true } },
  pinnedWithProject: { props: { inPinnedSection: true, showProjectName: true } },
  hideRepoBadge: { props: { hideRepoBadge: true } },
  hostLabel: { props: { hostContextLabel: 'build-box' } },
  hostLabelWithProject: { props: { hostContextLabel: 'build-box', showProjectName: true } },
  lineage: {
    props: {
      lineageChildCount: 2,
      lineageChildWorktreeIds: ['c1', 'c2'],
      onLineageToggle: () => {}
    }
  },
  affiliate: { props: { affiliateListMode: true } },
  activeLinear: { props: { isActive: true }, worktree: { linkedLinearIssue: 'ORC-2' } },
  flushIndented: { props: { flushSurface: true, contentIndent: 24 } },
  indented: { props: { contentIndent: 16 } }
}

// Proof each case draws what it is named for, so a parity pass is not two empty cards.
const SHOWS: Partial<Record<keyof typeof CASES, string>> = {
  sparse: 'sparse',
  renameFailed: 'rename failed',
  removalError: 'data-worktree-card-delete-failed',
  merging: 'Merging',
  remoteConflict: 'already exists',
  cacheTimer: 'data-cache-timer',
  deleteQuickAction: 'Delete workspace',
  lineage: 'data-lineage-toggle',
  details: 'Waiting on review',
  activeLinear: 'Linear'
}

const STYLES: Record<string, Partial<GlobalSettings>> = {
  classic: { compactWorktreeCards: false },
  compact: { compactWorktreeCards: true },
  new: { experimentalNewWorktreeCardStyle: true }
}

function Harness({ props, variant }: { props: WorktreeCardProps; variant: 'legacy' | 'template' }) {
  const card = useWorktreeCardController({
    isActiveSurface: props.isActive,
    activeSurfaceVariant: 'primary',
    isMultiSelected: false,
    revealHighlight: false,
    revealHighlightTone: 'default',
    nativeDragEnabled: true,
    inPinnedSection: false,
    contentIndent: 0,
    flushSurface: false,
    lineageChildCount: 0,
    lineageCollapsed: false,
    isLineageDropTarget: false,
    affiliateListMode: false,
    statusPrDisplay: null,
    ...props
  })
  if (variant === 'legacy') {
    const presentation = buildWorktreeCardPresentation(card)
    return (
      <div
        data-single-line={presentation.titleOnlyCard}
        data-style={JSON.stringify(presentation.cardStyle ?? null)}
      >
        <WorktreeCardParentContent card={card} presentation={presentation} />
      </div>
    )
  }
  const geometryFor = (statusLane: boolean) =>
    getWorktreeCardFrameGeometry({
      flushSurface: card.flushSurface,
      contentIndent: card.contentIndent,
      statusLane
    })
  const { content, frame } = renderWorkspaceCardTemplate(
    card,
    DEFAULT_WORKSPACE_CARD_TEMPLATE,
    (f) => {
      const margin = geometryFor(f.statusLane).parentContentMarginLeft
      return margin < 0 ? { style: { marginLeft: `${margin}px` } } : undefined
    }
  )
  return (
    <div
      data-single-line={frame.singleLine}
      data-style={JSON.stringify(geometryFor(frame.statusLane).cardStyle ?? null)}
    >
      {content}
    </div>
  )
}

/** Attribute order and class token order do not change what the browser draws. */
function canonical(html: string): string {
  const host = document.createElement('div')
  host.innerHTML = html
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ?? ''
    }
    if (!(node instanceof Element)) {
      return ''
    }
    const attrs = [...node.attributes]
      .map((attr) =>
        attr.name === 'class'
          ? `class="${attr.value.split(/\s+/).filter(Boolean).sort().join(' ')}"`
          : `${attr.name}="${attr.value}"`
      )
      .sort()
    return `<${node.localName} ${attrs.join(' ')}>${[...node.childNodes].map(walk).join('')}</${node.localName}>`
  }
  // React's generated ids depend on tree position, not on what is drawn.
  const ids = new Map<string, string>()
  return [...host.childNodes]
    .map(walk)
    .join('')
    .replace(/_R_[A-Za-z0-9]+_/g, (id) => {
      if (!ids.has(id)) {
        ids.set(id, `id${ids.size}`)
      }
      return ids.get(id) ?? id
    })
}

// Why a window: full card markup is too long for a readable assertion diff.
function aroundFirstDifference(actual: string, expected: string): [string, string] {
  let index = 0
  while (index < actual.length && actual[index] === expected[index]) {
    index++
  }
  const start = Math.max(0, index - 120)
  return [actual.slice(start, index + 240), expected.slice(start, index + 240)]
}

describe('default workspace card template parity with the original card', () => {
  beforeEach(() => {
    mocks.cacheStartedAt = null
    mocks.deleteModifier = false
  })

  for (const [styleName, style] of Object.entries(STYLES)) {
    for (const [caseName, testCase] of Object.entries(CASES)) {
      it(`${styleName}: ${caseName}`, () => {
        mocks.cacheStartedAt = testCase.cacheStartedAt ?? null
        mocks.deleteModifier = testCase.deleteModifier ?? false
        mocks.state = {
          agentActivityDisplayMode: 'full',
          deleteStateByWorktreeId: {},
          gitConflictOperationByWorktree: {},
          hostedReviewCache: {},
          issueCache: {},
          linearIssueCache: {},
          prCache: {},
          projectGroups: [],
          remoteBranchConflictByWorktreeId: {},
          runtimeEnvironments: [],
          settings: { ...style },
          sshConnectionStates: new Map(),
          removedSshTargetLabels: new Map(),
          runtimeStatusByEnvironmentId: new Map(),
          sshTargetLabels: new Map(),
          tabsByWorktree: {},
          agentStatusByPaneKey: {},
          retainedAgentsByPaneKey: {},
          workspacePortScan: null,
          worktreeCardProperties: testCase.cardProps ?? [...DEFAULT_WORKTREE_CARD_PROPERTIES],
          ...testCase.state
        }
        const props: WorktreeCardProps = {
          worktree: makeWorktree(testCase.worktree),
          repo: testCase.repo === null ? undefined : { ...repo, ...testCase.repo },
          isActive: false,
          ...testCase.props
        }
        const legacy = canonical(renderToStaticMarkup(<Harness props={props} variant="legacy" />))
        const template = canonical(
          renderToStaticMarkup(<Harness props={props} variant="template" />)
        )
        const shows = SHOWS[caseName]
        if (shows) {
          expect(legacy).toContain(shows)
        }
        const [actualWindow, expectedWindow] = aroundFirstDifference(template, legacy)
        expect(actualWindow).toBe(expectedWindow)
      })
    }
  }
})
