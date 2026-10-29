// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { emitCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { encodePaletteIdentity } from '../../../shared/palette-match/palette-ranking'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  LEAF_ID,
  makeAgentEntry,
  makeDuplicateRecentTabState,
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

// Stub activation at its boundary; the palette contract is which result it hands over.
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
    // Pass controlled cmdk value through so Enter-target assertions reflect actual selection.
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
  return [
    ...testContainer.querySelectorAll<HTMLElement>(
      `[data-command-item^="${encodePaletteIdentity(['worktree'])}"]`
    )
  ].map((node) => node.textContent ?? '')
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
  return [
    ...testContainer.querySelectorAll<HTMLElement>(
      `[data-command-item^="${encodePaletteIdentity(['workspace-tab'])}"]`
    )
  ]
    .map((node) => node.dataset.commandItem ?? '')
    .map(
      (id) =>
        Object.values(useAppStore.getState().unifiedTabsByWorktree)
          .flat()
          .find(
            (tab) => encodePaletteIdentity(['workspace-tab', '', tab.worktreeId, tab.id]) === id
          )?.id ?? ''
    )
}
function getTabRowShortcutDigits(): string[] {
  return [
    ...testContainer.querySelectorAll<HTMLElement>(
      `[data-command-item^="${encodePaletteIdentity(['workspace-tab'])}"]`
    )
  ].flatMap((row) =>
    [...row.querySelectorAll<HTMLElement>('span')]
      .map((node) => node.textContent ?? '')
      .filter((text) => /^\d+$/.test(text))
  )
}
function clickSeeMore(): void {
  ;[...testContainer.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('See more'))
    ?.click()
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
    expect(rows[0].startsWith(encodePaletteIdentity(['workspace-tab']))).toBe(true)
    expect(rows.some((id) => id.startsWith(encodePaletteIdentity(['worktree'])))).toBe(true)
    expect(testContainer.textContent).toContain('Recent Chats & Terminals')
    expect(testContainer.textContent).toContain('Recent Workspaces')
  })

  it('keeps duplicate persisted tab ids as separate recent rows and digit targets', async () => {
    await renderPalette(makeDuplicateRecentTabState())

    expect(
      getRenderedRowIds().filter((id) => id.startsWith(encodePaletteIdentity(['workspace-tab'])))
    ).toEqual([
      encodePaletteIdentity(['workspace-tab', 'ssh:alpha', 'wt-alpha', 'tab-duplicate']),
      encodePaletteIdentity(['workspace-tab', 'ssh:beta', 'wt-beta', 'tab-duplicate'])
    ])

    await act(async () => {
      emitCmdJRowIndexJump(1)
    })
    await flushEffects()

    expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-duplicate', worktreeId: 'wt-beta' })
    )
  })

  it('caps the recent section so the worktree header stays above the fold', async () => {
    await renderPalette(makeManyTabState(12))

    expect(getTabRowIds()).toHaveLength(6)
    expect(testContainer.textContent).toContain('Recent Workspaces')
    // Maintain the 10-row total cap even before the order snapshot arrives.
    expect(getWorktreeRows().length).toBeLessThanOrEqual(4)
  })
  it('shows more recent chats and terminals from the empty-query view', async () => {
    await renderPalette(makeManyTabState(12))
    const seeMoreButton = [...testContainer.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('See more')
    )
    expect(seeMoreButton).toBeDefined()
    expect(testContainer.textContent).toContain('6 more')
    await act(async () => {
      seeMoreButton?.click()
    })
    await flushEffects()
    expect(getTabRowIds()).toHaveLength(12)
    expect(testContainer.textContent).not.toContain('6 more')
  })
  it('reveals every recent row from a single expansion', async () => {
    await renderPalette(makeManyTabState(30))
    expect(getTabRowIds()).toHaveLength(6)
    await act(async () => {
      clickSeeMore()
    })
    await flushEffects()
    expect(getTabRowIds()).toHaveLength(30)
  })
  it('stops badging expanded recent rows at the last addressable digit', async () => {
    await renderPalette(makeManyTabState(12))
    expect(getTabRowShortcutDigits()).toEqual(['1', '2', '3', '4', '5', '6'])
    await act(async () => {
      clickSeeMore()
    })
    await flushEffects()
    expect(getTabRowIds()).toHaveLength(12)
    expect(getTabRowShortcutDigits()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('backfills past the cap when rows drop out of the frozen order', async () => {
    await renderPalette(makeManyTabState(12))
    const before = getTabRowIds()

    // Narrowing away the first page must expose later ranked rows rather than an empty section.
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
    expect(rows[0]).toBe(encodePaletteIdentity(['workspace-tab', '', 'wt-host', 'tab-host']))
    expect(rows).toContain(encodePaletteIdentity(['worktree', '|wt-weak']))
    expect(getCommandValue()).toBe(
      encodePaletteIdentity(['workspace-tab', '', 'wt-host', 'tab-host'])
    )
  })

  it('selects the new first result when cmdk reports the deferred list selection', async () => {
    await renderPalette(makeTypedRelevanceState())

    await act(async () => {
      setCommandQuery?.('improve')
    })
    await flushEffects()
    expect(getCommandValue()).toBe(encodePaletteIdentity(['worktree', '|wt-weak']))

    await act(async () => {
      setCommandQuery?.('perf')
      setCommandSelection?.(encodePaletteIdentity(['worktree', '|wt-weak']))
    })
    await flushEffects()

    expect(getRenderedRowIds().find((id) => id.length > 0)).toBe(
      encodePaletteIdentity(['workspace-tab', '', 'wt-host', 'tab-host'])
    )
    expect(getCommandValue()).toBe(
      encodePaletteIdentity(['workspace-tab', '', 'wt-host', 'tab-host'])
    )
  })

  // Honor onValueChange after ranking; cmdk’s advanced internal cursor otherwise makes the next ArrowDown a no-op.
  it('keeps arrow selection after the typed query ranking has committed', async () => {
    await renderPalette(makeTypedRelevanceState())

    await act(async () => {
      setCommandQuery?.('perf')
    })
    await flushEffects()
    expect(getCommandValue()).toBe(
      encodePaletteIdentity(['workspace-tab', '', 'wt-host', 'tab-host'])
    )

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
    expect(firstRow).toBe(encodePaletteIdentity(['worktree', '|wt-strong']))
  })

  it('ranks a typed query by match position inside the worktree section', async () => {
    await renderPalette({
      worktreesByRepo: {
        'repo-1': [
          // Preserve input order under smart sort so only relevance ranking can promote the prefix hit.
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

    // Whole-word perf outranks the prefix in performance despite input order.
    expect(
      getRenderedRowIds().filter((id) => id.startsWith(encodePaletteIdentity(['worktree'])))
    ).toEqual([
      encodePaletteIdentity(['worktree', '|wt-prefix']),
      encodePaletteIdentity(['worktree', '|wt-word-b']),
      encodePaletteIdentity(['worktree', '|wt-word-a'])
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

    // Dropping all recent tabs must retain the workspace cap, not mount every workspace.
    expect(getTabRowIds()).toEqual([])
    expect(getWorktreeRows()).toHaveLength(10)
    expect(testContainer.textContent).toContain('4 more')
  })

  it('captures the order when tabs hydrate after the palette is already open', async () => {
    const hydrated = makeRecentTabState()
    await renderPalette({
      ...hydrated,
      tabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    expect(getTabRowIds()).toEqual([])
    // Before hydration, cmdk auto-selects the first workspace it sees.
    const firstWorktreeId = getRenderedRowIds().find((id) =>
      id.startsWith(encodePaletteIdentity(['worktree']))
    )
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
    expect(getCommandValue()).toBe(
      getRenderedRowIds().find((id) => id.startsWith(encodePaletteIdentity(['workspace-tab'])))
    )

    // Empty snapshots must not leave digit shortcuts unbound until reopen.
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

    const worktreeIds = getRenderedRowIds().filter((id) =>
      id.startsWith(encodePaletteIdentity(['worktree']))
    )
    expect(worktreeIds.length).toBeGreaterThan(1)
    // Use a non-first row to prove the user moved selection.
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

  it('preserves visit ordering and selection when terminal entities hydrate', async () => {
    const hydrated = makeRecentTabState({
      agentStatusByPaneKey: {
        [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'blocked', Date.now())
      },
      unifiedTabsByWorktree: {
        'wt-alpha': [
          {
            ...makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat'),
            lastFocusedAt: Date.now() - 3 * 86400_000
          }
        ],
        'wt-beta': [
          {
            ...makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'Beta chat'),
            lastFocusedAt: Date.now()
          }
        ]
      }
    })
    await renderPalette({ ...hydrated, tabsByWorktree: {} })
    expect(getTabRowIds()).toEqual(['tab-beta', 'tab-alpha'])
    const movedTo = getRenderedRowIds().filter((id) =>
      id.startsWith(encodePaletteIdentity(['workspace-tab']))
    )[1]
    await act(async () => {
      setCommandSelection?.(movedTo)
    })
    await flushEffects()
    await act(async () => {
      useAppStore.setState({ tabsByWorktree: hydrated.tabsByWorktree } as Partial<AppState>)
    })
    await flushEffects()
    expect(getTabRowIds()).toEqual(['tab-beta', 'tab-alpha'])
    expect(getCommandValue()).toBe(movedTo)
  })

  it('admits a high-signal current tab whose terminal entity hydrates late', async () => {
    // Wait for the terminal entity before freezing attention membership or late current tabs stay excluded for the whole open.
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

  it('ranks a recently visited idle tab above a three-day-old blocked tab', async () => {
    await renderPalette(
      makeRecentTabState({
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'blocked', Date.now())
        },
        unifiedTabsByWorktree: {
          'wt-alpha': [
            {
              ...makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat'),
              lastFocusedAt: Date.now() - 3 * 86400_000
            }
          ],
          'wt-beta': [
            {
              ...makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'Beta chat'),
              lastFocusedAt: Date.now()
            }
          ]
        }
      })
    )

    expect(getTabRowIds()).toEqual(['tab-beta', 'tab-alpha'])
  })

  it('freezes the order captured on open while statuses keep changing', async () => {
    await renderPalette(
      makeRecentTabState({
        unifiedTabsByWorktree: {
          'wt-alpha': [
            {
              ...makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat'),
              lastFocusedAt: Date.now() - 3 * 86400_000
            }
          ],
          'wt-beta': [
            {
              ...makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'Beta chat'),
              lastFocusedAt: Date.now()
            }
          ]
        }
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

    // The retained palette clears queries after the snapshot effect; reopening must not freeze an old query’s subset.
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
        unifiedTabsByWorktree: {
          'wt-alpha': [
            {
              ...makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat'),
              lastFocusedAt: Date.now() - 3 * 86400_000
            }
          ],
          'wt-beta': [
            {
              ...makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'Beta chat'),
              lastFocusedAt: Date.now()
            }
          ]
        }
      })
    )

    // Attention on the current tab still earns a row; idle current tabs do not.
    expect(getTabRowIds()).toEqual(['tab-beta', 'tab-alpha'])
    expect(testContainer.textContent).toContain('Current Tab')
  })

  it.each([undefined, true])('excludes current terminal outcomes', async (interrupted) => {
    await renderPalette(
      makeRecentTabState({
        activeWorktreeId: 'wt-alpha',
        activeTabType: 'terminal',
        activeTabId: 'term-alpha',
        activeTabIdByWorktree: { 'wt-alpha': 'term-alpha' },
        activeTabTypeByWorktree: { 'wt-alpha': 'terminal' },
        agentStatusByPaneKey: {
          [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'done', Date.now(), {
            interrupted
          })
        }
      })
    )

    // Viewed completion stays done for 30 minutes after auto-ack; it must not displace offscreen news.
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

    // Offscreen completion still earns entry.
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
        // Exercise pane-only unacknowledged completion independently of unreadTerminalTabs.
        unreadAgentCompletionPanes: { [makePaneKey('term-alpha', LEAF_ID)]: true }
      })
    )

    expect(getTabRowIds()).toContain('tab-alpha')
  })

  it('keeps the recent section under a sidebar-seeded repository filter and refreshes on clear', async () => {
    const secondRepo = { ...makeRepo(), id: 'repo-2', path: '/repos/repo-2', displayName: 'Repo 2' }
    await renderPalette({
      ...makeRecentTabState(),
      repos: [makeRepo(), secondRepo],
      worktreesByRepo: {
        'repo-1': [makeWorktree('wt-alpha', 'Alpha workspace')],
        'repo-2': [makeWorktree('wt-beta', 'Beta workspace', { repoId: 'repo-2' })]
      },
      filterRepoIds: ['repo-1']
    })

    // The seeded filter narrows the recent rows instead of dropping the section.
    expect(testContainer.textContent).toContain('Recent Chats & Terminals')
    expect(getTabRowIds()).toEqual(['tab-alpha'])

    await act(async () => {
      ;[...testContainer.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Clear all'))
        ?.click()
    })
    await flushEffects()

    expect(getTabRowIds()).toEqual(expect.arrayContaining(['tab-alpha', 'tab-beta']))
  })
})
