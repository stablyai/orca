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
  makeRecentTabState,
  makeRepo,
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

function getRenderedRowIds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item]')].map(
    (node) => node.dataset.commandItem ?? ''
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

    // Why: a frozen row must retain its live badge while staying in its original slot.
    expect(getTabRowIds()).toContain('tab-alpha')
    expect(testContainer.textContent).toContain('Alpha chat')
    expect(document.querySelector('[data-slot=tooltip-trigger]')?.textContent).toContain('Working')
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

    // Why: completion changes the frozen row's badge without removing its reserved slot.
    expect(getTabRowIds()).toContain('tab-alpha')
    expect(document.querySelector('[data-slot=tooltip-trigger]')?.textContent).toContain('Done')
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

    // Why: require the setter so this cannot silently exercise the empty-query section.
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
    expect(alphaRow?.querySelector('[data-slot=tooltip-trigger]')?.textContent).toContain('Working')
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
