// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckStatus, Repo, Worktree } from '../../../../shared/types'
import type { ParentPrChecksRow, ParentPrChecksRowStatus } from './parent-pr-checks-rows'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values ? fallback.replace('{{value0}}', String(values.value0)) : fallback
}))

vi.mock('@/lib/http-link-routing', () => ({
  openHttpLink: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./checks-panel-content', () => ({
  CHECK_COLOR: {
    success: 'success-color',
    failure: 'failure-color',
    pending: 'pending-color',
    neutral: 'neutral-color'
  },
  CHECK_ICON: {
    success: (props: { className?: string }) => <span data-icon="success" {...props} />,
    failure: (props: { className?: string }) => <span data-icon="failure" {...props} />,
    pending: (props: { className?: string }) => <span data-icon="pending" {...props} />,
    neutral: (props: { className?: string }) => <span data-icon="neutral" {...props} />
  },
  ChecksList: () => <div data-testid="checks-list" />,
  PullRequestIcon: (props: { className?: string }) => <span data-icon="review" {...props} />,
  prStateColor: () => 'state-color'
}))

import { FolderWorkspacePrChecksRow } from './FolderWorkspacePrChecksRow'

let container: HTMLDivElement
let root: Root

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/child',
    path: '/child',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: 'Enable child worktrees',
    comment: '',
    linkedIssue: null,
    linkedPR: 12,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git'
  }
}

function makeRow(
  overrides: Partial<ParentPrChecksRow> & {
    status?: ParentPrChecksRowStatus
    checkTone?: CheckStatus
  } = {}
): ParentPrChecksRow {
  return {
    id: 'row-1',
    refreshIdentity: 'row-1::feature',
    worktree: makeWorktree(),
    repo: makeRepo(),
    branch: 'feature',
    status: 'success',
    group: 'passing',
    checkTone: 'success',
    title: 'Review title',
    reviewLabel: '#12',
    reviewUrl: 'https://example.test/pr/12',
    reviewState: 'open',
    provider: 'github',
    summary: 'Checks passing',
    detailNames: [],
    checks: [],
    isRefreshing: false,
    hasLinkedReview: true,
    ...overrides
  }
}

function renderRow(row: ParentPrChecksRow): void {
  act(() => {
    root.render(
      <FolderWorkspacePrChecksRow
        row={row}
        expanded={false}
        onToggle={vi.fn()}
        onLoadCheckDetails={vi.fn(async () => null)}
      />
    )
  })
}

function iconNames(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-icon]')].map(
    (icon) => icon.dataset.icon ?? ''
  )
}

describe('FolderWorkspacePrChecksRow', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each([
    {
      status: 'success' as const,
      checkTone: 'success' as const,
      icon: 'success',
      color: 'success-color',
      summary: 'Checks passing'
    },
    {
      status: 'failing' as const,
      checkTone: 'failure' as const,
      icon: 'failure',
      color: 'failure-color',
      summary: 'Checks failing'
    }
  ])('shows $icon status as summary metadata after the review identity', (state) => {
    renderRow(
      makeRow({
        status: state.status,
        checkTone: state.checkTone,
        summary: state.summary
      })
    )

    expect(iconNames()).toEqual(['review', state.icon])
    expect(container.textContent).toContain('Enable child worktrees')
    expect(container.textContent).toContain(state.summary)
    expect(container.querySelector(`[data-icon="${state.icon}"]`)?.className).toContain(state.color)
    expect(container.querySelector(`[data-icon="${state.icon}"]`)?.className).not.toContain(
      'animate-spin'
    )
  })

  it('spins pending summary status like regular pending check rows', () => {
    renderRow(
      makeRow({
        status: 'pending',
        group: 'pending',
        checkTone: 'pending',
        summary: 'Checks pending'
      })
    )

    expect(iconNames()).toEqual(['review', 'pending'])
    expect(container.querySelector('[data-icon="pending"]')?.className).toContain('pending-color')
    expect(container.querySelector('[data-icon="pending"]')?.className).toContain('animate-spin')
  })

  it('spins loading summary status because it uses the pending check icon', () => {
    renderRow(
      makeRow({
        status: 'loading',
        group: 'unavailable',
        checkTone: 'pending',
        reviewLabel: null,
        reviewUrl: null,
        reviewState: null,
        provider: null,
        summary: 'Checking review status...'
      })
    )

    expect(iconNames()).toEqual(['review', 'pending'])
    expect(container.querySelector('[data-icon="pending"]')?.className).toContain('animate-spin')
  })

  it('does not render a dashed neutral status glyph for rows without a known check state', () => {
    renderRow(
      makeRow({
        status: 'noReview',
        group: 'noPr',
        checkTone: 'neutral',
        reviewLabel: null,
        reviewUrl: null,
        reviewState: null,
        provider: null,
        summary: 'No PR linked'
      })
    )

    expect(iconNames()).toEqual(['review'])
    expect(container.querySelector('[data-icon="neutral"]')).toBeNull()
    expect(container.textContent).toContain('No PR linked')
  })
})
