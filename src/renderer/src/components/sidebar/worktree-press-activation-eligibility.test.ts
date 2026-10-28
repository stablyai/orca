import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { canActivateWorktreeOnPress } from './worktree-press-activation-eligibility'

const WORKTREE_ID = 'repo-1::/repo'
const LOCAL_REPO = { id: 'repo-1', path: '/repo' }
const WSL_TWIN_REPO = { ...LOCAL_REPO, executionHostId: toRuntimeExecutionHostId('env-wsl') }
let state: Record<string, unknown> = {}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => state }
}))

vi.mock('./use-worktree-sleep-state', () => ({
  selectIsSleepingWorktree: () => false
}))

describe('press activation hosts', () => {
  beforeEach(() => {
    state = {
      activeView: 'terminal',
      sleepingAgentSessionsByPaneKey: {},
      folderWorkspaces: [],
      projectGroups: [],
      repos: [LOCAL_REPO],
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    }
  })

  it('presses only into local workspaces', () => {
    expect(canActivateWorktreeOnPress({ worktreeId: WORKTREE_ID, rowHostId: 'local' })).toBe(true)
    for (const rowHostId of [toSshExecutionHostId('devbox'), toRuntimeExecutionHostId('env-wsl')]) {
      expect(canActivateWorktreeOnPress({ worktreeId: WORKTREE_ID, rowHostId })).toBe(false)
    }
  })

  it('keeps click activation for a local row whose id also names a remote twin', () => {
    state = { ...state, repos: [WSL_TWIN_REPO, LOCAL_REPO] }
    expect(canActivateWorktreeOnPress({ worktreeId: WORKTREE_ID, rowHostId: 'local' })).toBe(false)
  })

  it('keeps click activation when a terminal would spawn', () => {
    for (const terminals of [{ ptyIdsByTabId: { 'tab-1': [] } }, { tabsByWorktree: {} }]) {
      state = { ...state, ...terminals }
      expect(canActivateWorktreeOnPress({ worktreeId: WORKTREE_ID, rowHostId: 'local' })).toBe(
        false
      )
    }
  })
})
