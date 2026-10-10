// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  focusTerminalTabSurface: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

vi.mock('../../lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))
vi.mock('../../runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

import { useAppStore } from '../../store'
import { useTabGroupActivationCommands } from './useTabGroupActivationCommands'
import type { TabGroupWorktreeSnapshot } from './useTabGroupItemProjections'

const TERMINAL_TAB: Tab = {
  id: 'unified-terminal',
  entityId: 'terminal-a',
  groupId: 'group-1',
  worktreeId: 'worktree-a',
  contentType: 'terminal',
  label: 'Terminal',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

const WORKTREE_STATE: TabGroupWorktreeSnapshot = {
  groups: [],
  unifiedTabs: [TERMINAL_TAB],
  terminalTabs: [],
  openFiles: [],
  browserTabs: [],
  expandedPaneByTabId: {},
  terminalLayoutsByTabId: {
    'terminal-a': { root: null, activeLeafId: 'leaf-1', expandedLeafId: null }
  },
  generatedTabTitlesEnabled: false,
  mobileEmulatorEnabled: false
}

beforeEach(() => {
  useAppStore.setState({
    focusGroup: vi.fn(),
    activateTab: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    activeGroupIdByWorktree: {}
  })
})

afterEach(() => vi.clearAllMocks())

function activateTerminal(worktreeState: TabGroupWorktreeSnapshot): void {
  const { result } = renderHook(() =>
    useTabGroupActivationCommands({
      groupId: 'group-1',
      worktreeId: 'worktree-a',
      groupTabs: [TERMINAL_TAB],
      worktreeState
    })
  )
  result.current.activateTerminal('terminal-a')
}

describe('useTabGroupActivationCommands', () => {
  it('rebuilds the macOS text input context when a terminal tab is activated', () => {
    activateTerminal(WORKTREE_STATE)

    // Why: returning from a browser tab can leave the helper's native input context stale, which
    // drops every typed character; the refresh is the recovery the other focus handoffs already use.
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('terminal-a', 'leaf-1', {
      refreshImeContext: true
    })
  })

  it('refreshes even when the clicked terminal is already the focused group active tab', () => {
    // Why: the tab strip focuses its group on pointerdown, before activation runs on pointerup, so a
    // terminal left for a browser in another split group looks "already focused" at this point.
    useAppStore.setState({ activeGroupIdByWorktree: { 'worktree-a': 'group-1' } })
    activateTerminal({
      ...WORKTREE_STATE,
      groups: [
        {
          id: 'group-1',
          worktreeId: 'worktree-a',
          activeTabId: TERMINAL_TAB.id,
          tabOrder: [TERMINAL_TAB.id]
        }
      ]
    })

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('terminal-a', 'leaf-1', {
      refreshImeContext: true
    })
  })
})
