import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

import WorktreeJumpPalette from './WorktreeJumpPalette'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  LEAF_ID,
  makeAgentEntry,
  makeGroup,
  makeRecentTabState,
  makeRepo,
  makeUnifiedTab
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

vi.mock('@/components/sidebar/workspace-card/surface/StatusIndicator', () => ({
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
vi.mock('@/lib/workspace/search/tabs/workspace-tab-palette-activation', () => ({
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
  })

  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
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
      useAppStore.setState({ unreadTerminalTabs: { 'term-alpha': true } })
    })
    await flushEffects()

    // Freeze membership/order per open so late arrivals cannot move rows or digit shortcuts under the cursor.
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
        agentStatusByPaneKey: acceptedAgentStatuses(
          Object.entries({
            [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry(
              'term-alpha',
              'working',
              Date.now()
            )
          })
        )
      })
    })
    await flushEffects()

    // Frozen rows keep live badges without moving their slots.
    expect(getTabRowIds()).toContain('tab-alpha')
    expect(testContainer.textContent).toContain('Alpha chat')
    expect(document.querySelector('[data-slot=tooltip-trigger]')?.textContent).toContain('Working')
  })
})
