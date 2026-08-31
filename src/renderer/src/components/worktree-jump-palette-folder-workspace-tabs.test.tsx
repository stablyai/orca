// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import {
  makeGroup,
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

// Why stubbed: activation reaches into the whole workspace-reveal path; the palette's own
// contract is which result it hands over, so assert on that.
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
const WORKSPACE_KEY = 'folder:fw-tasks'
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-tasks',
    projectGroupId: 'group-tasks',
    name: 'Tasks',
    folderPath: '/tmp/tasks',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

/** One worktree with a tab plus one folder workspace holding the ticket tab. */
function makeFolderWorkspaceTabState(
  folderWorkspace: FolderWorkspace,
  overrides: Partial<AppState> = {}
): Partial<AppState> {
  return {
    worktreesByRepo: { 'repo-1': [makeWorktree('wt-alpha', 'Alpha workspace')] },
    folderWorkspaces: [folderWorkspace],
    showSleepingWorkspaces: true,
    ptyIdsByTabId: {
      'term-alpha': ['pty-term-alpha'],
      'term-tasks': ['pty-term-tasks']
    },
    tabsByWorktree: {
      'wt-alpha': [makeTerminalTab('term-alpha', 'wt-alpha', 'Alpha chat')],
      [WORKSPACE_KEY]: [makeTerminalTab('term-tasks', WORKSPACE_KEY, 'zsh')]
    },
    unifiedTabsByWorktree: {
      'wt-alpha': [makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat')],
      [WORKSPACE_KEY]: [
        makeUnifiedTab('tab-tasks', WORKSPACE_KEY, 'term-tasks', 'ORCA-42 payment retries')
      ]
    },
    groupsByWorktree: {
      'wt-alpha': [makeGroup('wt-alpha', ['tab-alpha'])],
      [WORKSPACE_KEY]: [makeGroup(WORKSPACE_KEY, ['tab-tasks'])]
    },
    activeGroupIdByWorktree: {
      'wt-alpha': 'group-wt-alpha',
      [WORKSPACE_KEY]: `group-${WORKSPACE_KEY}`
    },
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
    alwaysShowDefaultBranchWorkspace: true,
    lastVisitedAtByWorktreeId: {},
    ...overrides
  } as Partial<AppState>)

  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

async function search(query: string): Promise<void> {
  await act(async () => {
    setCommandQuery?.(query)
  })
  await flushEffects()
}

function getTabRow(tabId: string): HTMLElement | null {
  return testContainer.querySelector<HTMLElement>(`[data-command-item="workspace-tab:${tabId}"]`)
}

function getTabRowIds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item^="workspace-tab:"]')]
    .map((node) => node.dataset.commandItem ?? '')
    .map((id) => id.replace('workspace-tab:', ''))
}

describe('WorktreeJumpPalette folder-workspace tabs', () => {
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

  it('finds a folder-workspace tab by its title', async () => {
    await renderPalette(makeFolderWorkspaceTabState(makeFolderWorkspace()))
    await search('ORCA-42')

    expect(getTabRowIds()).toEqual(['tab-tasks'])
    expect(getTabRow('tab-tasks')?.textContent).toContain('Tasks')
  })

  it('hands the folder workspace key to activation when the row is chosen', async () => {
    await renderPalette(makeFolderWorkspaceTabState(makeFolderWorkspace()))
    await search('ORCA-42')

    await act(async () => {
      getTabRow('tab-tasks')?.click()
    })
    await flushEffects()

    expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-tasks',
        entityId: 'term-tasks',
        worktreeId: WORKSPACE_KEY,
        contentType: 'terminal'
      })
    )
  })

  it('labels a remote folder-workspace tab with its host', async () => {
    await renderPalette(
      makeFolderWorkspaceTabState(makeFolderWorkspace({ connectionId: 'remote-1' }), {
        sshTargetLabels: new Map([['remote-1', 'build-box']]),
        sshConnectionStates: new Map([['remote-1', { targetId: 'remote-1', status: 'connected' }]])
      } as Partial<AppState>)
    )
    await search('ORCA-42')

    const hostChip = getTabRow('tab-tasks')?.querySelector('[data-slot="palette-open-tab-host"]')
    expect(hostChip?.textContent).toBe('build-box')
  })

  it('ranks folder-workspace and worktree tabs in one list', async () => {
    // Why identical titles: with the match rank tied, position decides — and the busier
    // folder workspace can only outrank the worktree if one sort ordered both kinds.
    await renderPalette(
      makeFolderWorkspaceTabState(makeFolderWorkspace({ lastActivityAt: 5_000 }), {
        worktreesByRepo: {
          'repo-1': [makeWorktree('wt-alpha', 'Alpha workspace', { lastActivityAt: 1_000 })]
        },
        unifiedTabsByWorktree: {
          'wt-alpha': [
            makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'ORCA-42 payment retries')
          ],
          [WORKSPACE_KEY]: [
            makeUnifiedTab('tab-tasks', WORKSPACE_KEY, 'term-tasks', 'ORCA-42 payment retries')
          ]
        }
      })
    )
    await search('ORCA-42')

    expect(getTabRowIds()).toEqual(['tab-tasks', 'tab-alpha'])
  })
})
