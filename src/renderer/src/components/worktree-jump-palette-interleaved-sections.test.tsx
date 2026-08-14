// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import type { Repo } from '../../../shared/repo-types'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  layoutMultiPrimaryPaletteSections,
  orderMultiPrimaryPaletteItems
} from './cmd-j/palette-section-render-cap'
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

vi.mock('@/components/sidebar/StatusIndicator', () => ({
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
    CommandDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
      open ? <div data-command-dialog="true">{children}</div> : null,
    CommandInput: ({
      value,
      onValueChange
    }: {
      value?: string
      onValueChange?: (next: string) => void
    }) => {
      setCommandQuery = onValueChange ?? null
      return <input data-command-input="true" value={value} onChange={() => {}} />
    },
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
    CommandItem: ({ children, value }: { children: React.ReactNode; value?: string }) => (
      <button data-command-item={value ?? ''} type="button">
        {children}
      </button>
    )
  }
})

const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null

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

/** Both primaries overflow their first-screen slice, so the layout interleaves. */
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

/** Each primary row paired with the section header rendered above it, in DOM order. */
function getPrimaryRowsBySectionHeader(): { header: string; rowId: string }[] {
  const headerLabels = new Set(['Open Tabs', 'Worktrees'])
  const pairs: { header: string; rowId: string }[] = []
  let header = ''
  for (const node of testContainer.querySelectorAll<HTMLElement>(
    '[data-command-item], .uppercase'
  )) {
    const rowId = node.dataset.commandItem
    if (rowId) {
      if (rowId.startsWith('workspace-tab:') || rowId.startsWith('worktree:')) {
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
    // Why the counts: both remainders must still render, just under a re-emitted header.
    expect(rows.filter((row) => row.rowId.startsWith('workspace-tab:'))).toHaveLength(8)
    expect(rows.filter((row) => row.rowId.startsWith('worktree:'))).toHaveLength(5)
    for (const { header, rowId } of rows) {
      expect(header).toBe(rowId.startsWith('workspace-tab:') ? 'Open Tabs' : 'Worktrees')
    }
  })

  it('renders selectable rows in the same order as orderMultiPrimaryPaletteItems', async () => {
    await renderPalette(makeInterleavedQueryState())

    await act(async () => {
      setCommandQuery?.('perf')
    })
    await flushEffects()

    const renderedIds = Array.from(
      testContainer.querySelectorAll<HTMLElement>('[data-command-item]')
    )
      .map((el) => el.dataset.commandItem!)
      .filter((id) => id.startsWith('workspace-tab:') || id.startsWith('worktree:'))

    const tabIds = renderedIds.filter((id) => id.startsWith('workspace-tab:'))
    const worktreeIds = renderedIds.filter((id) => id.startsWith('worktree:'))

    const layout = layoutMultiPrimaryPaletteSections({
      leadingItems: tabIds,
      trailingItems: worktreeIds
    })
    const expectedOrder = orderMultiPrimaryPaletteItems(layout)
    expect(renderedIds).toEqual(expectedOrder)
  })

  it('keeps the Open Tabs header when a typed query only hits tabs', async () => {
    await renderPalette({
      worktreesByRepo: {
        'repo-1': [makeWorktree('wt-tabs', 'tab-host'), makeWorktree('wt-other', 'docs-only')]
      },
      showSleepingWorkspaces: true,
      ptyIdsByTabId: { 'term-0': ['pty-0'] },
      tabsByWorktree: {
        'wt-tabs': [makeTerminalTab('term-0', 'wt-tabs', 'ubuntu agent session')]
      },
      unifiedTabsByWorktree: {
        'wt-tabs': [makeUnifiedTab('tab-0', 'wt-tabs', 'term-0', 'ubuntu agent session')]
      },
      groupsByWorktree: { 'wt-tabs': [makeGroup('wt-tabs', ['tab-0'])] },
      activeGroupIdByWorktree: { 'wt-tabs': 'group-wt-tabs' }
    })

    await act(async () => {
      setCommandQuery?.('ubuntu')
    })
    await flushEffects()

    const rows = getPrimaryRowsBySectionHeader()
    expect(rows).toEqual([{ header: 'Open Tabs', rowId: 'workspace-tab:tab-0' }])
    expect(testContainer.textContent).toContain('Open Tabs')
    expect(testContainer.textContent).not.toContain('Worktrees')
  })

  it('puts the tab title on the left and the worktree name in the badge rail', async () => {
    const longTitle = 'macOS Orca App Permission Update Delivery'
    await renderPalette({
      worktreesByRepo: {
        'repo-1': [makeWorktree('wt-tabs', 'user-support')]
      },
      showSleepingWorkspaces: true,
      ptyIdsByTabId: { 'term-0': ['pty-0'] },
      tabsByWorktree: {
        'wt-tabs': [makeTerminalTab('term-0', 'wt-tabs', longTitle)]
      },
      unifiedTabsByWorktree: {
        'wt-tabs': [makeUnifiedTab('tab-0', 'wt-tabs', 'term-0', longTitle)]
      },
      groupsByWorktree: { 'wt-tabs': [makeGroup('wt-tabs', ['tab-0'])] },
      activeGroupIdByWorktree: { 'wt-tabs': 'group-wt-tabs' }
    })

    const row = testContainer.querySelector('[data-command-item="workspace-tab:tab-0"]')
    expect(row).not.toBeNull()
    const title = row?.querySelector('[data-slot="palette-open-tab-title"]')
    const worktree = row?.querySelector('[data-slot="palette-open-tab-worktree"]')
    expect(title?.textContent).toBe(longTitle)
    expect(worktree?.textContent).toBe('user-support')
    expect(worktree?.compareDocumentPosition(title ?? document.createElement('span'))).toBe(
      Node.DOCUMENT_POSITION_PRECEDING
    )
  })

  it('tags the worktree rail label as a branch when the visible name is the branch', async () => {
    await renderPalette({
      worktreesByRepo: {
        'repo-1': [makeWorktree('wt-tabs', '', { displayName: '' })]
      },
      showSleepingWorkspaces: true,
      ptyIdsByTabId: { 'term-0': ['pty-0'] },
      tabsByWorktree: {
        'wt-tabs': [makeTerminalTab('term-0', 'wt-tabs', 'Query the API')]
      },
      unifiedTabsByWorktree: {
        'wt-tabs': [makeUnifiedTab('tab-0', 'wt-tabs', 'term-0', 'Query the API')]
      },
      groupsByWorktree: { 'wt-tabs': [makeGroup('wt-tabs', ['tab-0'])] },
      activeGroupIdByWorktree: { 'wt-tabs': 'group-wt-tabs' }
    })

    const row = testContainer.querySelector('[data-command-item="workspace-tab:tab-0"]')
    expect(row).not.toBeNull()
    const worktree = row?.querySelector('[data-slot="palette-open-tab-worktree"]')
    expect(worktree?.textContent).toBe('main')
  })
})
