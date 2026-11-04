// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import type { Repo } from '../../../../shared/repo-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import WorktreeJumpPalette from './WorktreeJumpPalette'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

vi.mock('@/components/sidebar/workspace-card/surface/StatusIndicator', () => ({
  default: () => <span data-status-indicator="true" />
}))

vi.mock('@/components/repo/RepoBadgeLabel', () => ({
  RepoBadgeMark: () => <span data-repo-badge-mark="true" />
}))

vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: { value?: string }
    }) =>
      open ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null,
    CommandInput: React.forwardRef(function CommandInput(
      {
        value,
        onValueChange
      }: {
        value?: string
        onValueChange?: (next: string) => void
      },
      ref: React.ForwardedRef<HTMLInputElement>
    ) {
      setCommandQuery = onValueChange ?? null
      return <input ref={ref} data-command-input="true" value={value} onChange={() => {}} />
    }),
    CommandList: React.forwardRef(function CommandList(
      { children }: { children: React.ReactNode },
      ref: React.ForwardedRef<HTMLDivElement>
    ) {
      return (
        <div ref={ref} data-command-list="true">
          {children}
        </div>
      )
    }),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => (
      <div data-command-empty="true">{children}</div>
    ),
    CommandItem: ({
      children,
      value,
      onSelect
    }: {
      children: React.ReactNode
      value?: string
      onSelect?: () => void
    }) => (
      <button
        cmdk-item=""
        data-value={value ?? ''}
        data-command-item={value ?? ''}
        type="button"
        onClick={onSelect}
      >
        {children}
      </button>
    )
  }
})

const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null

const WORKSPACE_TAB_ITEM_PREFIX = encodePaletteIdentity(['workspace-tab'])
const WORKTREE_ITEM_PREFIX = encodePaletteIdentity(['worktree'])

function isWorkspaceTabItemId(id: string): boolean {
  return id.startsWith(WORKSPACE_TAB_ITEM_PREFIX)
}

function isWorktreeItemId(id: string): boolean {
  return id.startsWith(WORKTREE_ITEM_PREFIX)
}

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repos/repo-1',
    displayName: 'Repo 1',
    badgeColor: '#000000',
    addedAt: 0
  }
}

function makeWorktree(
  id: string,
  displayName: string,
  overrides: Partial<Worktree> = {}
): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string, title: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeUnifiedTab(id: string, worktreeId: string, entityId: string, label: string): Tab {
  return {
    id,
    entityId,
    groupId: `group-${worktreeId}`,
    worktreeId,
    contentType: 'terminal',
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeGroup(worktreeId: string, tabIds: string[]): TabGroup {
  return {
    id: `group-${worktreeId}`,
    worktreeId,
    activeTabId: tabIds[0] ?? null,
    tabOrder: tabIds,
    recentTabIds: tabIds
  }
}

function makeInterleavedQueryState(): Partial<AppState> {
  const tabIds = Array.from({ length: 8 }, (_, index) => `${index}`)
  return {
    worktreesByRepo: {
      'repo-1': [
        makeWorktree('wt-tabs', 'tab-host'),
        ...Array.from({ length: 5 }, (_, index) =>
          makeWorktree(`wt-${index}`, `improve-perf-${index}`)
        )
      ]
    },
    showSleepingWorkspaces: true,
    ptyIdsByTabId: Object.fromEntries(tabIds.map((id) => [`term-${id}`, [`pty-${id}`]])),
    tabsByWorktree: {
      'wt-tabs': tabIds.map((id) => makeTerminalTab(`term-${id}`, 'wt-tabs', `Perf chat ${id}`))
    },
    unifiedTabsByWorktree: {
      'wt-tabs': tabIds.map((id) =>
        makeUnifiedTab(`tab-${id}`, 'wt-tabs', `term-${id}`, `Perf chat ${id}`)
      )
    },
    groupsByWorktree: {
      'wt-tabs': [
        makeGroup(
          'wt-tabs',
          tabIds.map((id) => `tab-${id}`)
        )
      ]
    },
    activeGroupIdByWorktree: { 'wt-tabs': 'group-wt-tabs' }
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderPalette(overrides: Partial<AppState>): Promise<void> {
  useAppStore.setState({
    activeModal: 'worktree-palette',
    activeWorktreeId: null,
    repos: [makeRepo()],
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    unifiedTabsByWorktree: {},
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    alwaysShowDefaultBranchWorkspace: true,
    lastVisitedAtByWorktreeId: {},
    ...overrides
  } as Partial<AppState>)

  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

function getPrimaryRowsBySectionHeader(): { header: string; rowId: string }[] {
  const headerLabels = new Set(['Open Tabs', 'Workspaces'])
  const pairs: { header: string; rowId: string }[] = []
  let header = ''
  for (const node of testContainer.querySelectorAll<HTMLElement>(
    '[data-command-item], .uppercase'
  )) {
    const rowId = node.dataset.commandItem
    if (rowId) {
      if (isWorkspaceTabItemId(rowId) || isWorktreeItemId(rowId)) {
        pairs.push({ header, rowId })
      }
      continue
    }
    const label = node.textContent?.trim() ?? ''
    if (!node.closest('[data-command-item]') && headerLabels.has(label)) {
      header = label
    }
  }
  return pairs
}

describe('WorktreeJumpPalette interleaved primary sections', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => {
      testRoot.unmount()
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('keeps every interleaved row under its own section header', async () => {
    await renderPalette(makeInterleavedQueryState())

    await act(async () => {
      setCommandQuery?.('perf')
    })
    await flushEffects()

    const rows = getPrimaryRowsBySectionHeader()
    expect(rows.filter((row) => isWorkspaceTabItemId(row.rowId))).toHaveLength(8)
    expect(rows.filter((row) => isWorktreeItemId(row.rowId))).toHaveLength(5)
    for (const { header, rowId } of rows) {
      expect(header).toBe(isWorkspaceTabItemId(rowId) ? 'Open Tabs' : 'Workspaces')
    }
  })

  it('allows clicking See more on empty query to expand worktree cap by 20', async () => {
    const worktrees = Array.from({ length: 35 }, (_, index) =>
      makeWorktree(`wt-${index}`, `project-wt-${index}`)
    )
    await renderPalette({
      worktreesByRepo: { 'repo-1': worktrees },
      showSleepingWorkspaces: true
    })

    expect(testContainer.textContent).toContain('25 more')
    const seeMoreBtn = Array.from(testContainer.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('See more')
    )
    expect(seeMoreBtn).toBeDefined()
    const initialItemIds = Array.from(testContainer.querySelectorAll('[cmdk-item]')).map((item) =>
      item.getAttribute('data-value')
    )
    const seeMoreIndex = initialItemIds.indexOf('__hint_worktree_overflow__')
    expect(seeMoreIndex).toBeGreaterThan(0)
    const input = testContainer.querySelector<HTMLInputElement>('[data-command-input="true"]')
    input?.focus()

    await act(async () => {
      seeMoreBtn?.click()
    })
    await flushEffects()

    const renderedItems = testContainer.querySelectorAll(
      `[data-command-item^="${WORKTREE_ITEM_PREFIX}"]`
    )
    expect(renderedItems).toHaveLength(30)
    expect(testContainer.textContent).toContain('5 more')
    const firstRevealedItemId = Array.from(testContainer.querySelectorAll('[cmdk-item]'))[
      seeMoreIndex
    ]?.getAttribute('data-value')
    expect(firstRevealedItemId).toMatch(new RegExp(`^${WORKTREE_ITEM_PREFIX}`))
    expect(firstRevealedItemId).not.toBe(initialItemIds[0])
    expect(
      testContainer
        .querySelector('[data-command-dialog="true"]')
        ?.getAttribute('data-command-value')
    ).toBe(firstRevealedItemId)
    expect(document.activeElement).toBe(input)

    const seeMoreBtn2 = Array.from(testContainer.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('See more')
    )
    await act(async () => {
      seeMoreBtn2?.click()
    })
    await flushEffects()

    const renderedItemsAll = testContainer.querySelectorAll(
      `[data-command-item^="${WORKTREE_ITEM_PREFIX}"]`
    )
    expect(renderedItemsAll).toHaveLength(35)
    expect(testContainer.textContent).not.toContain('more')
  })
})
