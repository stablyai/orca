// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { emitCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  LEAF_ID,
  makeAgentEntry,
  makeGroup,
  makeManyTabState,
  makeRecentTabState,
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'

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
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

  // Why: after typing, arrow moves must stick. Dropping onValueChange while cmdk already
  // advanced its internal cursor made the next ArrowDown a no-op (Object.is short-circuit).
  it('keeps arrow selection after the typed query ranking has committed', async () => {
    await renderPalette(makeTypedRelevanceState())

    await act(async () => {
      setCommandQuery?.('perf')
    })
    await flushEffects()
    expect(getCommandValue()).toBe('workspace-tab:tab-host')

    const rows = getRenderedRowIds().filter((id) => id.length > 0)
    expect(rows.length).toBeGreaterThan(1)

    await act(async () => {
      setCommandSelection?.(rows[1])
    })
    await flushEffects()

    expect(getCommandValue()).toBe(rows[1])
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

    // Why word-b beats word-a despite input order: `perf` is a whole word in
    // `rc-perf-update-channels` but only a prefix of `performance`.
    expect(getRenderedRowIds().filter((id) => id.startsWith('worktree:'))).toEqual([
      'worktree:wt-prefix',
      'worktree:wt-word-b',
      'worktree:wt-word-a'
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

  it('re-ranks once when terminal entities hydrate after unified tabs', async () => {
    // Why split hydration: unified tabs can land before tabsByWorktree; without a re-capture every
    // row ranks IDLE. A deliberate second-row highlight must survive that one re-rank.
    const hydrated = makeRecentTabState({
      agentStatusByPaneKey: {
        [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'blocked', Date.now())
      },
      lastVisitedAtByWorktreeId: { 'wt-beta': Date.now() }
    })
    await renderPalette({ ...hydrated, tabsByWorktree: {} })
    expect(getTabRowIds()).toEqual(['tab-beta', 'tab-alpha'])
    const movedTo = `workspace-tab:${getTabRowIds()[1]}`
    await act(async () => {
      setCommandSelection?.(movedTo)
    })
    await flushEffects()
    await act(async () => {
      useAppStore.setState({ tabsByWorktree: hydrated.tabsByWorktree } as Partial<AppState>)
    })
    await flushEffects()
    expect(getTabRowIds()).toEqual(['tab-alpha', 'tab-beta'])
    expect(getCommandValue()).toBe(movedTo)
  })

  it('admits a high-signal current tab whose terminal entity hydrates late', async () => {
    // Why: with no tabsByWorktree entity the current tab's badge is unknowable, so membership is
    // too — an attention-ready capture there would freeze it out of Recent for the whole open.
    const hydrated = makeRecentTabState({
      activeWorktreeId: 'wt-alpha',
      activeTabType: 'terminal',
      activeTabId: 'term-alpha',
      activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
      activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
      agentStatusByPaneKey: {
        [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'blocked', Date.now())
      }
    })
    await renderPalette({ ...hydrated, tabsByWorktree: {} })
    expect(getTabRowIds()).toEqual(['tab-beta'])

    await act(async () => {
      useAppStore.setState({ tabsByWorktree: hydrated.tabsByWorktree } as Partial<AppState>)
    })
    await flushEffects()

    expect(getTabRowIds()).toEqual(['tab-alpha', 'tab-beta'])
  })

  it('ranks a blocked agent above a more recently visited idle tab', async () => {
    await renderPalette(
      makeRecentTabState({
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'blocked', Date.now())
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
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'blocked', Date.now())
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

  it('excludes the idle current tab from the recent section', async () => {
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

  it('keeps the current tab in recent when its agent needs permission', async () => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'blocked', Date.now())
        },
        lastVisitedAtByWorktreeId: { 'wt-beta': Date.now() }
      })
    )

    // Why: high-signal current tabs stay scannable (ask-question / permission badge) even though
    // idle "where you are" rows are still dropped.
    expect(getTabRowIds()).toEqual(['tab-alpha', 'tab-beta'])
    expect(testContainer.textContent).toContain('Current Tab')
  })

  it('keeps the current tab in recent when its agent is working', async () => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'working', Date.now())
        }
      })
    )

    expect(getTabRowIds()).toContain('tab-alpha')
  })

  it('keeps the current tab in recent when it has unread activity', async () => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
        unreadTerminalTabs: { 'term-alpha': true }
      })
    )

    expect(getTabRowIds()).toContain('tab-alpha')
  })

  it('excludes the current tab when its agent is merely done', async () => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'done', Date.now())
        }
      })
    )

    // Why: a completion you watched land needs no row — `done` outlives the unread auto-ack by the
    // whole 30m staleness window, so the slot goes to a workspace off screen instead.
    expect(getTabRowIds()).toEqual(['tab-beta'])
  })

  it('still lists a non-current tab whose agent is done', async () => {
    await renderPalette(
      makeRecentTabState({
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'done', Date.now())
        }
      })
    )

    // Why: `done` only stops earning *entry* for the tab on screen — elsewhere it is still news.
    expect(getTabRowIds()).toContain('tab-alpha')
  })

  it('keeps the current tab in recent on a pane-only unread completion marker', async () => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
        // Why pane-keyed only: the narrower marker (unacked completion in one pane) is its own
        // inclusion input — unreadTerminalTabs stays empty here.
        unreadAgentCompletionPanes: { [makePaneKey('term-alpha', LEAF_ID)]: true }
      })
    )

    expect(getTabRowIds()).toContain('tab-alpha')
  })

  it('excludes the current editor tab — no agent ladder can lift it out of "you are here"', async () => {
    const fileId = '/repo/wt-alpha/notes.ts'
    const state = makeRecentTabState({
      activeWorktreeId: 'wt-alpha',
      activeTabType: 'editor',
      activeTabTypeByWorktree: { 'wt-alpha': 'editor' },
      activeFileId: fileId,
      activeFileIdByWorktree: { 'wt-alpha': fileId },
      openFiles: [
        {
          id: fileId,
          filePath: fileId,
          relativePath: 'notes.ts',
          worktreeId: 'wt-alpha',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    })
    await renderPalette({
      ...state,
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        'wt-alpha': [
          {
            ...makeUnifiedTab('tab-alpha-file', 'wt-alpha', fileId, 'notes.ts'),
            contentType: 'editor'
          },
          ...(state.unifiedTabsByWorktree?.['wt-alpha'] ?? [])
        ]
      },
      groupsByWorktree: {
        ...state.groupsByWorktree,
        'wt-alpha': [makeGroup('wt-alpha', ['tab-alpha-file', 'tab-alpha'])]
      }
    })

    expect(getTabRowIds()).not.toContain('tab-alpha-file')
    expect(getTabRowIds()).toContain('tab-alpha')

    // Proves the exclusion is the current-tab rule, not a missing index entry: search still finds it.
    await act(async () => {
      setCommandQuery?.('notes')
    })
    await flushEffects()
    expect(getTabRowIds()).toContain('tab-alpha-file')
  })

  it('excludes an archived worktree tab even with a blocked agent', async () => {
    const alpha = makeWorktree('wt-alpha', 'Alpha workspace', { isArchived: true })
    const beta = makeWorktree('wt-beta', 'Beta workspace')
    await renderPalette(
      makeRecentTabState({
        worktreesByRepo: { 'repo-1': [alpha, beta] },
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'blocked', Date.now())
        }
      })
    )

    expect(getTabRowIds()).toEqual(['tab-beta'])
  })

  it('does not admit the current tab mid-open when it goes unread', async () => {
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

    await act(async () => {
      useAppStore.setState({ unreadTerminalTabs: { 'term-alpha': true } } as Partial<AppState>)
    })
    await flushEffects()

    // Why frozen: membership shares the open-time snapshot with the row order, so a late arrival
    // can't insert a row under the cursor and renumber ⌘1–6. It joins on the next open.
    expect(getTabRowIds()).toEqual(['tab-beta'])
  })

  it('keeps a frozen current row listed after it quiets mid-open', async () => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
        unreadTerminalTabs: { 'term-alpha': true }
      })
    )

    expect(getTabRowIds()).toContain('tab-alpha')

    await act(async () => {
      useAppStore.setState({
        unreadTerminalTabs: {},
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'working', Date.now())
        }
      } as Partial<AppState>)
    })
    await flushEffects()

    // Why: the row stays where the frozen order put it, and its badge must keep resolving — row
    // data covers every open tab, so inclusion dropping it can't blank the pip mid-open.
    expect(getTabRowIds()).toContain('tab-alpha')
    expect(testContainer.textContent).toContain('Alpha chat')
    expect(testContainer.querySelector('[title="Working"]')).not.toBeNull()
  })

  it('keeps a frozen current row listed when its agent finishes mid-open', async () => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'working', Date.now())
        }
      })
    )

    expect(getTabRowIds()).toContain('tab-alpha')

    await act(async () => {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'done', Date.now())
        }
      } as Partial<AppState>)
    })
    await flushEffects()

    // Why: `done` gates entry, not rendering — a row already in the frozen order keeps its slot and
    // flips to the completed check rather than blanking under the cursor.
    expect(getTabRowIds()).toContain('tab-alpha')
    expect(testContainer.querySelector('[title="Done"]')).not.toBeNull()
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

  it('keeps the agent badge on an Open Tabs row a query surfaced', async () => {
    await renderPalette(
      makeRecentTabState({
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'working', Date.now())
        }
      })
    )

    // Why not optional-call: a skipped setter would leave the empty-query Recent section standing
    // and the assertions below would pass without the query path ever running.
    const applyQuery = setCommandQuery
    if (!applyQuery) {
      throw new Error('CommandInput never installed a query setter')
    }
    await act(async () => {
      applyQuery('Alpha')
    })
    await flushEffects()

    // Why: searching for a tab is exactly when its status matters — the pip must survive the query.
    expect(getTabRowIds()).toContain('tab-alpha')
    expect(getTabRowIds()).not.toContain('tab-beta')
    const alphaRow = testContainer.querySelector<HTMLElement>(
      '[data-command-item="workspace-tab:tab-alpha"]'
    )
    expect(alphaRow?.querySelector('[title="Working"]')).not.toBeNull()
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
