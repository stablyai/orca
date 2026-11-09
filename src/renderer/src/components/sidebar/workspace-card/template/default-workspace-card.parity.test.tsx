// @vitest-environment happy-dom

import React, { type ReactNode } from 'react'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'

import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../../../shared/worktree/card-properties'
import type { WorktreeCardProps } from '../controller/worktree-card-model'

type Mocks = {
  state: Record<string, unknown>
  cacheStartedAt: number | null
  deleteModifier: boolean
  hoverOpenChange: ((open: boolean) => void) | undefined
}
const mocks = vi.hoisted((): Mocks => ({
  state: {},
  cacheStartedAt: null,
  deleteModifier: false,
  hoverOpenChange: undefined
}))

vi.mock('@/store', () => {
  const getState = () => mocks.state
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState
    })
  }
})
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    open,
    onOpenChange
  }: {
    children: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => {
    mocks.hoverOpenChange = onOpenChange
    return (
      <div data-hover-card="" data-hover-open={Boolean(open)}>
        {children}
      </div>
    )
  },
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
vi.mock('../activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
}))
vi.mock('../../workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false,
  selectIsSleepingWorktree: () => false
}))
vi.mock('../activity/CacheTimer', () => ({
  default: ({ startedAt }: { startedAt: number }) => <span data-cache-timer={startedAt} />,
  usePromptCacheCountdownStartedAt: () => mocks.cacheStartedAt
}))
vi.mock('../activity/WorktreeCardAgents', () => ({
  default: ({ className }: { className?: string }) => (
    <div className={className} data-worktree-agents="" />
  )
}))
vi.mock('../identity/WorktreeLineageToggle', () => ({
  WorktreeLineageToggle: ({ count, label }: { count: number; label: string }) => (
    <button type="button" data-lineage-toggle={count}>
      {label}
    </button>
  )
}))
vi.mock(
  '../../workspace-actions/deletion/workspace-delete-quick-action',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkspaceDeleteModifierPressed: () => mocks.deleteModifier
  })
)

const { useWorktreeCardController } = await import('../controller/use-worktree-card-controller')
const { buildWorktreeCardPresentation } = await import('../surface/worktree-card-presentation')
const { WorktreeCardParentContent } = await import('../surface/worktree-card-parent-content')
const { getWorktreeCardFrameGeometry } = await import('../surface/worktree-card-frame-geometry')
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

type Case = {
  worktree?: Partial<Worktree>
  repo?: Partial<Repo> | null
  props?: Partial<WorktreeCardProps>
  state?: Record<string, unknown>
  cardProps?: WorktreeCardProperty[]
  cacheStartedAt?: number
  deleteModifier?: boolean
}

// Proof each case draws what it is named for, so a parity pass is not two empty cards.

const STYLES: Record<string, Partial<GlobalSettings>> = {
  classic: { compactWorktreeCards: false },
  compact: { compactWorktreeCards: true },
  new: { experimentalNewWorktreeCardStyle: true }
}

function stateFor(style: Partial<GlobalSettings>, testCase: Case): Record<string, unknown> {
  return {
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

// Why a window: full card markup is too long for a readable assertion diff.

describe('default workspace card template parity with the original card', () => {
  beforeEach(() => {
    mocks.cacheStartedAt = null
    mocks.deleteModifier = false
    mocks.hoverOpenChange = undefined
  })
  afterEach(cleanup)

  it('suppresses a delayed details hover while a template identity icon is focused', () => {
    mocks.state = stateFor(STYLES.new, {})
    const { container } = render(
      <Harness
        props={{
          worktree: makeWorktree({ isSparse: true, sparseDirectories: ['src'] }),
          repo,
          isActive: false
        }}
        variant="template"
      />
    )
    const icon = screen.getByRole('img', { name: 'Sparse checkout' })
    const hover = container.querySelector('[data-hover-card]')
    expect(hover).not.toBeNull()
    expect(mocks.hoverOpenChange).toBeTypeOf('function')

    act(() => icon.focus())
    act(() => mocks.hoverOpenChange?.(true))
    expect(hover?.getAttribute('data-hover-open')).toBe('false')

    act(() => icon.blur())
    act(() => mocks.hoverOpenChange?.(true))
    expect(hover?.getAttribute('data-hover-open')).toBe('true')
  })
})
