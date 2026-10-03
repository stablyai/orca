import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TabGroupWorktreeSnapshot } from './useTabGroupItemProjections'

const mocks = vi.hoisted(() => ({
  store: {
    focusGroup: vi.fn(),
    activateTab: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveBrowserTab: vi.fn()
  },
  focusTerminalTabSurface: vi.fn(),
  activateWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  browserWorkspaceHasRemoteOwner: vi.fn()
}))
vi.mock('react', () => ({ useCallback: (callback: unknown) => callback }))
vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    {
      getState: () => mocks.store
    }
  )
}))
vi.mock('../../lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))
vi.mock('../../runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'remote-1'
}))
vi.mock('@/runtime/remote-browser-tab-ownership', () => ({
  browserWorkspaceHasRemoteOwner: mocks.browserWorkspaceHasRemoteOwner
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: vi.fn()
}))

import { useTabGroupActivationCommands } from './useTabGroupActivationCommands'

function useCommands(contentType: Tab['contentType']) {
  const tab: Tab = {
    id: 'unified-1',
    entityId: 'entity-1',
    worktreeId: 'folder:one',
    groupId: 'group-1',
    contentType,
    label: '',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return useTabGroupActivationCommands({
    groupId: tab.groupId,
    worktreeId: tab.worktreeId,
    groupTabs: [tab],
    worktreeState: {
      terminalLayoutsByTabId: { 'entity-1': { activeLeafId: 'leaf-2' } }
    } as unknown as TabGroupWorktreeSnapshot
  })
}

describe('tab group activation content effects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.browserWorkspaceHasRemoteOwner.mockReturnValue(true)
  })

  it('selects the terminal entity, routes its runtime, and restores the active leaf', () => {
    useCommands('terminal').activateTerminal('entity-1')
    expect(mocks.store.focusGroup).toHaveBeenCalledWith('folder:one', 'group-1')
    expect(mocks.store.activateTab.mock.calls[0][0]).toBe('unified-1')
    expect(mocks.store.focusGroup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.store.activateTab.mock.invocationCallOrder[0]
    )
    expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'folder:one',
      tabId: 'entity-1',
      environmentId: 'remote-1'
    })
    expect(mocks.store.setActiveTab).toHaveBeenCalledWith('entity-1')
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('entity-1', 'leaf-2')
  })

  it.each([true, false])(
    'preserves browser ownership routing (remote owner: %s)',
    (remoteOwner) => {
      mocks.browserWorkspaceHasRemoteOwner.mockReturnValue(remoteOwner)
      useCommands('browser').activateBrowser('entity-1')
      expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledTimes(remoteOwner ? 1 : 0)
      if (remoteOwner) {
        expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledWith({
          worktreeId: 'folder:one',
          tabId: 'unified-1',
          environmentId: 'remote-1'
        })
      }
      expect(mocks.store.setActiveBrowserTab).toHaveBeenCalledWith('entity-1')
      expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('browser')
    }
  )

  it.each(['editor', 'diff', 'simulator'] as const)('preserves %s surface effects', (type) => {
    useCommands(type).activateEditor('unified-1')
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith(
      type === 'simulator' ? 'simulator' : 'editor'
    )
    expect(mocks.store.setActiveFile).toHaveBeenCalledTimes(type === 'simulator' ? 0 : 1)
    if (type !== 'simulator') {
      expect(mocks.store.setActiveFile).toHaveBeenCalledWith('entity-1')
    }
  })

  it('ignores targets absent from the group', () => {
    const actions = useCommands('terminal')
    actions.activateTerminal('missing')
    actions.activateBrowser('missing')
    actions.activateEditor('missing')
    expect(mocks.store.focusGroup).not.toHaveBeenCalled()
    expect(mocks.store.activateTab).not.toHaveBeenCalled()
  })
})
