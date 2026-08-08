// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import type { Repo, Tab, TabGroup, TerminalTab, Worktree } from '../../../shared/types'
import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { emitCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
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

// Why: activation reaches into window.api and the whole worktree-reveal path; the palette's own
// contract is which result it hands over, so stub the boundary and assert on that.
const { activateWorkspaceTabPaletteResult } = vi.hoisted(() => ({
  activateWorkspaceTabPaletteResult: vi.fn((_result: unknown) => ({ status: 'activated' }) as const)
}))
vi.mock('@/lib/workspace-tab-palette-activation', () => ({
  activateWorkspaceTabPaletteResult: (result: unknown) => activateWorkspaceTabPaletteResult(result)
}))

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    // Why the commandProps passthrough: cmdk resolves Enter against its `value`, so the controlled
    // value is the only honest stand-in for "what would Enter activate" without mounting real cmdk.
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: { value?: string; onValueChange?: (next: string) => void }
    }) => {
      setCommandSelection = commandProps?.onValueChange ?? null
      return open ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null
    },
    CommandInput: ({
      value,
      onValueChange,
      placeholder
    }: {
      value?: string
      onValueChange?: (next: string) => void
      placeholder?: string
    }) => {
      setCommandQuery = onValueChange ?? null
      return (
        <input
          data-command-input="true"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
        />
      )
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
    CommandItem: ({
      children,
      onSelect,
      value
    }: {
      children: React.ReactNode
      onSelect?: (value: string) => void
      value?: string
    }) => (
      <button data-command-item={value ?? ''} onClick={() => onSelect?.(value ?? '')} type="button">
        {children}
      </button>
    )
  }
})

const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null
let setCommandSelection: ((next: string) => void) | null = null

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
    // Why explicit: the sweep exemption is what these cases probe, so it must
    // not ride on whatever the store default happens to be.
    alwaysShowDefaultBranchWorkspace: true,
    lastVisitedAtByWorktreeId: {},
    ...overrides
  } as Partial<AppState>)

  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

function getWorktreeRows(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item^="worktree:"]')].map(
    (node) => node.textContent ?? ''
  )
}

describe('WorktreeJumpPalette', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    setCommandSelection = null
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

  it('keeps every inactive main workspace visible when sleeping workspaces are hidden', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: false
    })

    expect(testContainer.textContent).toContain('Default branch workspace')
    expect(testContainer.textContent).not.toContain('Feature workspace')
    // Why kept: the exemption keys on isMainWorktree, not the branch name, so a
    // branchless folder workspace is the project's entry point too.
    expect(testContainer.textContent).toContain('Folder workspace')
  })

  it('keeps the explicit default-branch filter authoritative', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch] },
      showSleepingWorkspaces: false,
      hideDefaultBranchWorkspace: true
    })

    expect(testContainer.textContent).not.toContain('Default branch workspace')
  })

  it('keeps an active non-default workspace visible when sleeping workspaces are hidden', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: false,
      browserTabsByWorktree: {
        feature: [
          {
            id: 'browser-tab-1',
            worktreeId: 'feature',
            url: 'https://example.com',
            title: 'example.com',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      }
    })

    expect(testContainer.textContent).toContain('Feature workspace')
    expect(testContainer.textContent).toContain('Default branch workspace')
    // Why kept: same isMainWorktree exemption — folder workspaces are covered.
    expect(testContainer.textContent).toContain('Folder workspace')
  })

  it('sweeps the sleeping main workspace once the exemption is opted out', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature] },
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false
    })

    expect(getWorktreeRows()).toEqual([])
    expect(testContainer.textContent).not.toContain('Default branch workspace')
    expect(testContainer.textContent).not.toContain('Feature workspace')
  })

  it('keeps the show-sleeping baseline and empty-query ordering intact', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: true,
      lastVisitedAtByWorktreeId: {
        feature: 300,
        'default-branch': 200,
        'folder-main': 100
      }
    })

    expect(getWorktreeRows()).toEqual([
      expect.stringContaining('Feature workspace'),
      expect.stringContaining('Default branch workspace'),
      expect.stringContaining('Folder workspace')
    ])
  })

  it('keeps typed-query results on the full non-archived scope', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature] },
      showSleepingWorkspaces: false
    })

    expect(testContainer.textContent).not.toContain('Feature workspace')

    expect(setCommandQuery).not.toBeNull()

    await act(async () => {
      setCommandQuery?.('Feature')
    })
    await flushEffects()

    expect(testContainer.textContent).toContain('Feature workspace')
  })
})

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

const LEAF_ID = '11111111-2222-4333-8444-555555555555'

function makeAgentEntry(
  tabId: string,
  state: AgentStatusState,
  stateStartedAt: number
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: stateStartedAt,
    stateStartedAt,
    paneKey: `${tabId}:${LEAF_ID}`,
    stateHistory: []
  }
}

/** Two worktrees, one terminal tab each, none of them current. */
function makeRecentTabState(overrides: Partial<AppState> = {}): Partial<AppState> {
  const alpha = makeWorktree('wt-alpha', 'Alpha workspace')
  const beta = makeWorktree('wt-beta', 'Beta workspace')
  return {
    worktreesByRepo: { 'repo-1': [alpha, beta] },
    showSleepingWorkspaces: true,
    ptyIdsByTabId: {
      'term-alpha': ['pty-term-alpha'],
      'term-beta': ['pty-term-beta']
    },
    tabsByWorktree: {
      'wt-alpha': [makeTerminalTab('term-alpha', 'wt-alpha', 'Alpha chat')],
      'wt-beta': [makeTerminalTab('term-beta', 'wt-beta', 'Beta chat')]
    },
    unifiedTabsByWorktree: {
      'wt-alpha': [makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat')],
      'wt-beta': [makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'Beta chat')]
    },
    groupsByWorktree: {
      'wt-alpha': [makeGroup('wt-alpha', ['tab-alpha'])],
      'wt-beta': [makeGroup('wt-beta', ['tab-beta'])]
    },
    activeGroupIdByWorktree: {
      'wt-alpha': 'group-wt-alpha',
      'wt-beta': 'group-wt-beta'
    },
    ...overrides
  }
}

/** One tab-heavy worktree plus `count` bare ones, so both sections overflow their caps. */
function makeManyTabState(count: number): Partial<AppState> {
  const ids = Array.from({ length: count }, (_, index) => `${index}`)
  return {
    worktreesByRepo: {
      'repo-1': [
        makeWorktree('wt-many', 'Many workspace'),
        ...ids.map((id) => makeWorktree(`wt-${id}`, `Spare workspace ${id}`))
      ]
    },
    showSleepingWorkspaces: true,
    ptyIdsByTabId: Object.fromEntries(ids.map((id) => [`term-${id}`, [`pty-${id}`]])),
    tabsByWorktree: {
      'wt-many': ids.map((id) => makeTerminalTab(`term-${id}`, 'wt-many', `Chat ${id}`))
    },
    unifiedTabsByWorktree: {
      'wt-many': ids.map((id) => makeUnifiedTab(`tab-${id}`, 'wt-many', `term-${id}`, `Chat ${id}`))
    },
    groupsByWorktree: {
      'wt-many': [
        makeGroup(
          'wt-many',
          ids.map((id) => `tab-${id}`)
        )
      ]
    },
    activeGroupIdByWorktree: { 'wt-many': 'group-wt-many' }
  }
}

function getRenderedRowIds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item]')].map(
    (node) => node.dataset.commandItem ?? ''
  )
}

/** The id cmdk would activate on Enter. */
function getCommandValue(): string {
  return (
    testContainer.querySelector<HTMLElement>('[data-command-dialog]')?.dataset.commandValue ?? ''
  )
}

function getTabRowIds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item^="workspace-tab:"]')]
    .map((node) => node.dataset.commandItem ?? '')
    .map((id) => id.replace('workspace-tab:', ''))
}

describe('WorktreeJumpPalette recent chats & terminals', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    setCommandSelection = null
    activateWorkspaceTabPaletteResult.mockClear()
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

  it('leads the empty-query list with the recent section', async () => {
    await renderPalette(makeRecentTabState())

    const rows = getRenderedRowIds().filter((id) => id.length > 0)
    expect(rows[0]).toMatch(/^workspace-tab:/)
    expect(rows.some((id) => id.startsWith('worktree:'))).toBe(true)
    expect(testContainer.textContent).toContain('Recent Chats & Terminals')
    expect(testContainer.textContent).toContain('Recent Worktrees')
  })

  it('caps the recent section so the worktree header stays above the fold', async () => {
    await renderPalette(makeManyTabState(12))

    expect(getTabRowIds()).toHaveLength(6)
    expect(testContainer.textContent).toContain('Recent Worktrees')
    // Why: the worktree section shrinks against the recent rows so the list holds at 10 total —
    // it must never uncap, not even for the frame before the order snapshot lands.
    expect(getWorktreeRows().length).toBeLessThanOrEqual(4)
  })

  it('backfills past the cap when rows drop out of the frozen order', async () => {
    await renderPalette(makeManyTabState(12))
    const before = getTabRowIds()

    // Why: closing the whole first page stands in for any mid-open narrowing (a filter chip does the
    // same thing) — the section must fall through to the next ranked rows, not render empty.
    await act(async () => {
      useAppStore.setState({
        unifiedTabsByWorktree: {
          'wt-many': (useAppStore.getState().unifiedTabsByWorktree['wt-many'] ?? []).filter(
            (tab) => !before.includes(tab.id)
          )
        }
      } as Partial<AppState>)
    })
    await flushEffects()

    const after = getTabRowIds()
    expect(after).toHaveLength(6)
    expect(after.some((id) => before.includes(id))).toBe(false)
  })

  /** A tab whose title starts with the query, against worktrees that only match mid-name. */
  function makeTypedRelevanceState(): Partial<AppState> {
    const weak = makeWorktree('wt-weak', 'improve-agent-dashboard-performance')
    const host = makeWorktree('wt-host', 'docs-update')
    return {
      worktreesByRepo: { 'repo-1': [weak, host] },
      showSleepingWorkspaces: true,
      ptyIdsByTabId: { 'term-host': ['pty-term-host'] },
      tabsByWorktree: {
        'wt-host': [makeTerminalTab('term-host', 'wt-host', 'Performance Review Main Daemon')]
      },
      unifiedTabsByWorktree: {
        'wt-host': [
          makeUnifiedTab('tab-host', 'wt-host', 'term-host', 'Performance Review Main Daemon')
        ]
      },
      groupsByWorktree: { 'wt-host': [makeGroup('wt-host', ['tab-host'])] },
      activeGroupIdByWorktree: { 'wt-host': 'group-wt-host' }
    }
  }

  it('leads a typed query with the tab section when it holds the stronger match', async () => {
    await renderPalette(makeTypedRelevanceState())

    await act(async () => {
      setCommandQuery?.('perf')
    })
    await flushEffects()

    const rows = getRenderedRowIds().filter((id) => id.length > 0)
    expect(rows[0]).toBe('workspace-tab:tab-host')
    expect(rows).toContain('worktree:wt-weak')
    expect(getCommandValue()).toBe('workspace-tab:tab-host')
  })

  it('selects the new first result when cmdk reports the deferred list selection', async () => {
    await renderPalette(makeTypedRelevanceState())

    await act(async () => {
      setCommandQuery?.('improve')
    })
    await flushEffects()
    expect(getCommandValue()).toBe('worktree:wt-weak')

    await act(async () => {
      setCommandQuery?.('perf')
      setCommandSelection?.('worktree:wt-weak')
    })
    await flushEffects()

    expect(getRenderedRowIds().find((id) => id.length > 0)).toBe('workspace-tab:tab-host')
    expect(getCommandValue()).toBe('workspace-tab:tab-host')
  })

  it('keeps worktrees ahead of tabs when a worktree holds the stronger match', async () => {
    await renderPalette({
      ...makeTypedRelevanceState(),
      worktreesByRepo: {
        'repo-1': [
          makeWorktree('wt-strong', 'perf-diff-tighten'),
          makeWorktree('wt-host', 'docs-update')
        ]
      }
    })

    await act(async () => {
      setCommandQuery?.('perf-d')
    })
    await flushEffects()

    const firstRow = getRenderedRowIds().find((id) => id.length > 0)
    expect(firstRow).toBe('worktree:wt-strong')
  })

  it('ranks a typed query by match position inside the worktree section', async () => {
    await renderPalette({
      worktreesByRepo: {
        'repo-1': [
          // Why this order: smart sort keeps the input order here, so a promoted prefix hit can only
          // come from relevance re-ranking.
          makeWorktree('wt-word-a', 'improve-agent-dashboard-performance'),
          makeWorktree('wt-word-b', 'rc-perf-update-channels'),
          makeWorktree('wt-prefix', 'perf-diff-tighten')
        ]
      },
      showSleepingWorkspaces: true
    })

    await act(async () => {
      setCommandQuery?.('perf')
    })
    await flushEffects()

    // Why the two word-start rows keep their input order: relevance ranks by where the match sits
    // relative to a word boundary, not by raw offset — equal hits still defer to smart sort.
    expect(getRenderedRowIds().filter((id) => id.startsWith('worktree:'))).toEqual([
      'worktree:wt-prefix',
      'worktree:wt-word-a',
      'worktree:wt-word-b'
    ])
  })

  it('budget-caps the worktree section when nothing fills the recent one', async () => {
    await renderPalette({
      worktreesByRepo: {
        'repo-1': Array.from({ length: 14 }, (_, index) =>
          makeWorktree(`wt-${index}`, `Spare workspace ${index}`)
        )
      },
      showSleepingWorkspaces: true
    })

    // Why this shape: a filter chip that drops every open tab lands here too, and uncapping used to
    // mount one row per workspace.
    expect(getTabRowIds()).toEqual([])
    expect(getWorktreeRows()).toHaveLength(10)
    expect(testContainer.textContent).toContain('Type to see all 14 worktrees')
  })

  it('captures the order when tabs hydrate after the palette is already open', async () => {
    const hydrated = makeRecentTabState()
    await renderPalette({
      ...hydrated,
      tabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    expect(getTabRowIds()).toEqual([])
    // Why: cmdk claims the first row it sees, which before hydration is a worktree.
    const firstWorktreeId = getRenderedRowIds().find((id) => id.startsWith('worktree:'))
    expect(firstWorktreeId).toBeDefined()
    await act(async () => {
      setCommandSelection?.(firstWorktreeId ?? '')
    })
    await flushEffects()

    await act(async () => {
      useAppStore.setState({
        tabsByWorktree: hydrated.tabsByWorktree,
        unifiedTabsByWorktree: hydrated.unifiedTabsByWorktree
      } as Partial<AppState>)
    })
    await flushEffects()

    const [topRowId] = getTabRowIds()
    expect(getTabRowIds()).toHaveLength(2)
    // Enter has to follow the rows up: ⌘1 already points at the first recent chat.
    expect(getCommandValue()).toBe(`workspace-tab:${topRowId}`)

    // Why here: an empty snapshot also left the digit chords addressing nothing until reopen.
    await act(async () => {
      emitCmdJRowIndexJump(0)
    })
    await flushEffects()

    expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: topRowId })
    )
  })

  it('leaves a deliberately moved selection alone when recents land late', async () => {
    const hydrated = makeRecentTabState()
    await renderPalette({
      ...hydrated,
      tabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const worktreeIds = getRenderedRowIds().filter((id) => id.startsWith('worktree:'))
    expect(worktreeIds.length).toBeGreaterThan(1)
    // Why the second row: only a selection that differs from the auto-picked head proves the user moved it.
    const movedTo = worktreeIds[1]
    await act(async () => {
      setCommandSelection?.(movedTo)
    })
    await flushEffects()

    await act(async () => {
      useAppStore.setState({
        tabsByWorktree: hydrated.tabsByWorktree,
        unifiedTabsByWorktree: hydrated.unifiedTabsByWorktree
      } as Partial<AppState>)
    })
    await flushEffects()

    expect(getTabRowIds()).toHaveLength(2)
    expect(getCommandValue()).toBe(movedTo)
  })

  it('ranks a blocked agent above a more recently visited idle tab', async () => {
    await renderPalette(
      makeRecentTabState({
        agentStatusByPaneKey: {
          [`term-alpha:${LEAF_ID}`]: makeAgentEntry('term-alpha', 'blocked', Date.now())
        },
        lastVisitedAtByWorktreeId: { 'wt-beta': Date.now() }
      })
    )

    expect(getTabRowIds()).toEqual(['tab-alpha', 'tab-beta'])
  })

  it('freezes the order captured on open while statuses keep changing', async () => {
    await renderPalette(
      makeRecentTabState({
        lastVisitedAtByWorktreeId: { 'wt-beta': Date.now() }
      })
    )

    expect(getTabRowIds()).toEqual(['tab-beta', 'tab-alpha'])

    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [`term-alpha:${LEAF_ID}`]: makeAgentEntry('term-alpha', 'blocked', Date.now())
        }
      } as Partial<AppState>)
    })
    await flushEffects()

    expect(getTabRowIds()).toEqual(['tab-beta', 'tab-alpha'])
  })

  it('captures the unfiltered order when reopened after a search', async () => {
    await renderPalette(makeRecentTabState())

    await act(async () => {
      setCommandQuery?.('Alpha')
    })
    await flushEffects()

    // Why closed-then-reopened: the palette stays mounted, and the open effect clears the query one
    // commit after the snapshot effect — so a naive capture would freeze the Alpha-only subset.
    await act(async () => {
      useAppStore.setState({ activeModal: undefined } as Partial<AppState>)
    })
    await flushEffects()
    await act(async () => {
      useAppStore.setState({
        activeModal: 'worktree-palette'
      } as Partial<AppState>)
    })
    await flushEffects()

    expect(getTabRowIds()).toHaveLength(2)
  })

  it('excludes the current tab from the recent section', async () => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' }
      })
    )

    expect(getTabRowIds()).toEqual(['tab-beta'])
  })

  it('activates the row a digit chord addresses while open', async () => {
    await renderPalette(
      makeRecentTabState({
        lastVisitedAtByWorktreeId: { 'wt-beta': Date.now() }
      })
    )

    expect(getTabRowIds()).toEqual(['tab-beta', 'tab-alpha'])

    await act(async () => {
      emitCmdJRowIndexJump(1)
    })
    await flushEffects()

    expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-alpha' })
    )
  })

  it('ignores a digit chord beyond the rendered recent rows', async () => {
    await renderPalette(makeRecentTabState())

    await act(async () => {
      emitCmdJRowIndexJump(8)
    })
    await flushEffects()

    expect(activateWorkspaceTabPaletteResult).not.toHaveBeenCalled()
  })

  it('stops routing digit chords once a query is typed', async () => {
    await renderPalette(makeRecentTabState())

    await act(async () => {
      setCommandQuery?.('Alpha')
    })
    await flushEffects()

    await act(async () => {
      emitCmdJRowIndexJump(0)
    })
    await flushEffects()

    expect(activateWorkspaceTabPaletteResult).not.toHaveBeenCalled()
  })

  it('keeps create-worktree below the matches it would otherwise outrank', async () => {
    await renderPalette(makeRecentTabState())

    await act(async () => {
      setCommandQuery?.('Alpha')
    })
    await flushEffects()

    const rows = getRenderedRowIds().filter((id) => id.length > 0)
    expect(rows.at(-1)).toBe('__create_worktree__')
    expect(rows.length).toBeGreaterThan(1)
  })

  it('labels a folder workspace row with its display name, not a branch', async () => {
    await renderPalette(
      makeRecentTabState({
        worktreesByRepo: {
          'repo-1': [
            makeWorktree('wt-alpha', 'Alpha workspace', {
              isMainWorktree: true,
              branch: ''
            }),
            makeWorktree('wt-beta', 'Beta workspace')
          ]
        }
      })
    )

    expect(testContainer.textContent).toContain('Alpha workspace')
  })
})
