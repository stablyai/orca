import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createFloatingTerminalPanelInputsSelector } from './floating-terminal-panel-inputs'

const OTHER_WORKTREE_ID = 'worktree-other'

type State = Parameters<ReturnType<typeof createFloatingTerminalPanelInputsSelector>>[0]
type TerminalTab = NonNullable<AppState['tabsByWorktree'][string]>[number]
type BrowserTab = NonNullable<AppState['browserTabsByWorktree'][string]>[number]
type TabGroup = NonNullable<AppState['groupsByWorktree'][string]>[number]
type UnifiedTab = NonNullable<AppState['unifiedTabsByWorktree'][string]>[number]
type OpenFile = AppState['openFiles'][number]

function terminalTab(id: string, worktreeId: string = FLOATING_TERMINAL_WORKTREE_ID): TerminalTab {
  return { id, worktreeId } as TerminalTab
}

function browserTab(id: string, worktreeId: string = FLOATING_TERMINAL_WORKTREE_ID): BrowserTab {
  return { id, worktreeId } as BrowserTab
}

function group(id: string, worktreeId: string = FLOATING_TERMINAL_WORKTREE_ID): TabGroup {
  return { id, worktreeId } as TabGroup
}

function unifiedTab(id: string, worktreeId: string = FLOATING_TERMINAL_WORKTREE_ID): UnifiedTab {
  return { id, worktreeId } as UnifiedTab
}

function openFile(id: string, worktreeId: string): OpenFile {
  return { id, worktreeId } as OpenFile
}

function state(overrides: Partial<State> = {}): State {
  return {
    browserTabsByWorktree: {},
    expandedPaneByTabId: {},
    groupsByWorktree: {},
    openFiles: [],
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ...overrides
  }
}

describe('createFloatingTerminalPanelInputsSelector', () => {
  it('ignores unrelated workspace collection churn while the panel is retained', () => {
    const onExpandedTabVisited = vi.fn()
    const onOpenFileVisited = vi.fn()
    const select = createFloatingTerminalPanelInputsSelector({
      onExpandedTabVisited,
      onOpenFileVisited
    })
    const floatingTab = terminalTab('floating-terminal')
    const floatingBrowser = browserTab('floating-browser')
    const floatingGroup = group('floating-group')
    const floatingUnifiedTab = unifiedTab('floating-unified')
    const floatingFile = openFile('floating-file', FLOATING_TERMINAL_WORKTREE_ID)
    const initial = state({
      browserTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [floatingBrowser],
        [OTHER_WORKTREE_ID]: [browserTab('other-browser', OTHER_WORKTREE_ID)]
      },
      expandedPaneByTabId: { 'floating-terminal': true, 'other-terminal': true },
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [floatingGroup],
        [OTHER_WORKTREE_ID]: [group('other-group', OTHER_WORKTREE_ID)]
      },
      openFiles: [floatingFile, openFile('other-file', OTHER_WORKTREE_ID)],
      tabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab],
        [OTHER_WORKTREE_ID]: [terminalTab('other-terminal', OTHER_WORKTREE_ID)]
      },
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [floatingUnifiedTab],
        [OTHER_WORKTREE_ID]: [unifiedTab('other-unified', OTHER_WORKTREE_ID)]
      }
    })
    const first = select(initial)
    const afterUnrelatedWrites = state({
      browserTabsByWorktree: {
        ...initial.browserTabsByWorktree,
        [OTHER_WORKTREE_ID]: [browserTab('other-browser-next', OTHER_WORKTREE_ID)]
      },
      expandedPaneByTabId: { ...initial.expandedPaneByTabId, 'other-terminal': false },
      groupsByWorktree: {
        ...initial.groupsByWorktree,
        [OTHER_WORKTREE_ID]: [group('other-group-next', OTHER_WORKTREE_ID)]
      },
      openFiles: [floatingFile, openFile('other-file-next', OTHER_WORKTREE_ID)],
      tabsByWorktree: {
        ...initial.tabsByWorktree,
        [OTHER_WORKTREE_ID]: [terminalTab('other-terminal-next', OTHER_WORKTREE_ID)]
      },
      unifiedTabsByWorktree: {
        ...initial.unifiedTabsByWorktree,
        [OTHER_WORKTREE_ID]: [unifiedTab('other-unified-next', OTHER_WORKTREE_ID)]
      }
    })

    expect(select(afterUnrelatedWrites)).toBe(first)
    expect(select({ ...afterUnrelatedWrites })).toBe(first)
    expect(onOpenFileVisited).toHaveBeenCalledTimes(4)
    expect(onExpandedTabVisited).toHaveBeenCalledTimes(2)
  })

  it('updates each collection when the floating workspace itself changes', () => {
    const select = createFloatingTerminalPanelInputsSelector()
    let currentState = state()
    let previous = select(currentState)

    currentState = {
      ...currentState,
      tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [terminalTab('terminal')] }
    }
    let selected = select(currentState)
    expect(selected).not.toBe(previous)
    expect(selected.tabs.map((tab) => tab.id)).toEqual(['terminal'])
    previous = selected

    currentState = {
      ...currentState,
      browserTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [browserTab('browser')]
      }
    }
    selected = select(currentState)
    expect(selected).not.toBe(previous)
    expect(selected.browserTabs.map((tab) => tab.id)).toEqual(['browser'])
    previous = selected

    currentState = {
      ...currentState,
      groupsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [group('group')] }
    }
    selected = select(currentState)
    expect(selected).not.toBe(previous)
    expect(selected.groups.map((entry) => entry.id)).toEqual(['group'])
    previous = selected

    currentState = {
      ...currentState,
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [unifiedTab('unified')]
      }
    }
    selected = select(currentState)
    expect(selected).not.toBe(previous)
    expect(selected.unifiedTabs.map((tab) => tab.id)).toEqual(['unified'])
    previous = selected

    currentState = {
      ...currentState,
      openFiles: [openFile('file', FLOATING_TERMINAL_WORKTREE_ID)]
    }
    selected = select(currentState)
    expect(selected).not.toBe(previous)
    expect(selected.floatingFiles.map((file) => file.id)).toEqual(['file'])
    previous = selected

    currentState = { ...currentState, expandedPaneByTabId: { terminal: true } }
    selected = select(currentState)
    expect(selected).not.toBe(previous)
    expect(selected.expandedPaneByTabId).toEqual({ terminal: true })
    previous = selected

    currentState = { ...currentState, expandedPaneByTabId: { terminal: false } }
    selected = select(currentState)
    expect(selected).not.toBe(previous)
    expect(selected.expandedPaneByTabId).toEqual({})
  })

  it('excludes non-floating files and pane expansion state', () => {
    const select = createFloatingTerminalPanelInputsSelector()
    const selected = select(
      state({
        expandedPaneByTabId: { floating: false, other: true },
        openFiles: [
          openFile('floating-file', FLOATING_TERMINAL_WORKTREE_ID),
          openFile('other-file', OTHER_WORKTREE_ID)
        ],
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [terminalTab('floating')],
          [OTHER_WORKTREE_ID]: [terminalTab('other', OTHER_WORKTREE_ID)]
        }
      })
    )

    expect(selected.floatingFiles.map((file) => file.id)).toEqual(['floating-file'])
    expect(selected.expandedPaneByTabId).toEqual({})
  })
})
