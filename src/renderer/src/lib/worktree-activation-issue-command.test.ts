import { describe, expect, it } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset,
  setLegacySetupScriptLaunchMode,
  createdTabStartups
} from './worktree-activation.test-fixture'

registerWorktreeActivationReset()

describe('ensureWorktreeHasInitialTerminal', () => {
  it('queues an issue command split when issueCommand is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/issue-command-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/issue-command-runner.sh',
      env: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })
  })

  it('queues an issue command split through returned WSL shell metadata', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      runnerScriptPath: 'C:\\repo\\.git\\orca\\issue-command-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: { ORCA_ROOT_PATH: 'C:\\repo' }
    })

    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /mnt/c/repo/.git/orca/issue-command-runner.sh',
      env: { ORCA_ROOT_PATH: 'C:\\repo' }
    })
  })

  it('creates a Setup tab and queues issue automation on the primary terminal', () => {
    setLegacySetupScriptLaunchMode('split-vertical')
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
      },
      {
        runnerScriptPath: '/tmp/repo/.git/orca/issue-command-runner.sh',
        envVars: { ORCA_ROOT_PATH: '/tmp/repo' }
      }
    )

    expect(createdTabStartups(store)['tab-2']).toEqual({
      command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/issue-command-runner.sh',
      env: { ORCA_ROOT_PATH: '/tmp/repo' }
    })
  })

  it('does not queue issue command split when issueCommand is not provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(createdTabStartups(store)).toEqual({})
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })
})
