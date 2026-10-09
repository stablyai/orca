import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../store/types'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { makeLayout, makeTab, makeUnifiedTab } from '../store/slices/store-session-test-harness'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import { toWebTerminalSurfaceTabId } from './web-terminal-surface-id'
import {
  beginWebRuntimeSplitFocusRequest,
  captureWebRuntimeSplitFocusTarget,
  finishWebRuntimeSplitFocusRequest,
  focusSplitWebRuntimeTerminalPane
} from './web-runtime-split-focus'

const mocks = vi.hoisted(() => ({ getState: vi.fn(), focus: vi.fn(), refresh: vi.fn() }))
vi.mock('../store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('../lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: mocks.focus }))
vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.refresh
}))
vi.mock('./web-runtime-session-environment', () => ({ matchesWebSessionIntentOwner: () => true }))

const WORKTREE = 'repo1::/workspace/selected'
const TAB = toWebTerminalSurfaceTabId('host-tab')
const PTY = 'remote:hub-a@@terminal-1'
const SESSION_OWNER = { environmentId: 'hub-a', pairingRevision: 1 }
const OWNER: WorktreeSelectionOwner = {
  worktreeId: WORKTREE,
  publisherHostId: 'runtime:hub-a',
  executionHostId: 'ssh:private-host',
  instanceId: 'same-instance'
}
const SOURCE = { worktreeId: WORKTREE, tabId: TAB, leafId: 'source-leaf' }
const SPLIT = { handle: 'split-pty', tabId: 'host-tab', paneRuntimeId: 1, leafId: 'created-leaf' }

let state: Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorkspaceOwner'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeTabIdByWorktree'
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'groupsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
>
let request: ReturnType<typeof beginWebRuntimeSplitFocusRequest> | null

beforeEach(() => {
  vi.clearAllMocks()
  mocks.refresh.mockResolvedValue(undefined)
  request = null
  state = {
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: OWNER.executionHostId,
    activeWorkspaceOwner: OWNER,
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [WORKTREE]: 'terminal' },
    activeTabIdByWorktree: { [WORKTREE]: TAB },
    activeBrowserTabIdByWorktree: {},
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    groupsByWorktree: {},
    unifiedTabsByWorktree: {
      [WORKTREE]: [makeUnifiedTab({ id: TAB, worktreeId: WORKTREE, groupId: 'group-1' })]
    },
    tabsByWorktree: { [WORKTREE]: [makeTab({ id: TAB, worktreeId: WORKTREE, ptyId: PTY })] },
    terminalLayoutsByTabId: {
      [TAB]: {
        ...makeLayout(),
        activeLeafId: SOURCE.leafId,
        ptyIdsByLeafId: { [SOURCE.leafId]: PTY }
      }
    }
  }
  mocks.getState.mockImplementation(() => state)
})

afterEach(() => {
  finishWebRuntimeSplitFocusRequest(request)
  resetWebSessionFocusIntentForTests()
})

describe('split focus selected publisher guard', () => {
  it('refuses the old split response after a same-ID/raw-host publisher switch', async () => {
    const target = captureWebRuntimeSplitFocusTarget(PTY, SOURCE)
    expect(target).not.toBeNull()
    request = beginWebRuntimeSplitFocusRequest(SESSION_OWNER, WORKTREE)

    state.activeWorkspaceOwner = { ...OWNER, publisherHostId: 'runtime:hub-b' }
    await focusSplitWebRuntimeTerminalPane(SESSION_OWNER, target, request, SPLIT)

    expect(state.activeWorktreeId).toBe(WORKTREE)
    expect(state.activeWorkspaceExecutionHostId).toBe(OWNER.executionHostId)
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(peekWebSessionFocusIntent(SESSION_OWNER, WORKTREE)).toBeNull()
  })

  it('clears the pending focus intent when the publisher changes during snapshot refresh', async () => {
    let finishRefresh: (() => void) | undefined
    mocks.refresh.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRefresh = resolve
      })
    )
    const target = captureWebRuntimeSplitFocusTarget(PTY, SOURCE)
    expect(target).not.toBeNull()
    request = beginWebRuntimeSplitFocusRequest(SESSION_OWNER, WORKTREE)

    const pending = focusSplitWebRuntimeTerminalPane(SESSION_OWNER, target, request, SPLIT)
    expect(peekWebSessionFocusIntent(SESSION_OWNER, WORKTREE)).toMatchObject({
      hostTabId: SPLIT.tabId,
      leafId: SPLIT.leafId
    })
    state.activeWorkspaceOwner = { ...OWNER, publisherHostId: 'runtime:hub-b' }
    finishRefresh?.()
    await pending

    expect(state.activeWorktreeId).toBe(WORKTREE)
    expect(state.activeWorkspaceExecutionHostId).toBe(OWNER.executionHostId)
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(peekWebSessionFocusIntent(SESSION_OWNER, WORKTREE)).toBeNull()
  })

  it('focuses the new split when the same selected owner is copied', async () => {
    const target = captureWebRuntimeSplitFocusTarget(PTY, SOURCE)
    expect(target).not.toBeNull()
    request = beginWebRuntimeSplitFocusRequest(SESSION_OWNER, WORKTREE)

    state.activeWorkspaceOwner = { ...OWNER }
    await focusSplitWebRuntimeTerminalPane(SESSION_OWNER, target, request, SPLIT)

    expect(mocks.refresh).toHaveBeenCalledWith('hub-a', WORKTREE, {
      expectedEnvironmentPairingRevision: 1,
      acceptCurrentSnapshot: true
    })
    expect(mocks.focus).toHaveBeenCalledWith(TAB, SPLIT.leafId)
  })
})
