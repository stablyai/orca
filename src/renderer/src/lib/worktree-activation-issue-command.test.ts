import { describe, expect, it } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset,
  setSetupScriptLaunchMode
} from './worktree-activation-test-harness'

registerWorktreeActivationReset()

describe('ensureWorktreeHasInitialTerminal', () => {
  it('queues an issue command split when issueCommand is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      runnerScriptPath: '/tmp/repo/.git/mcode/issue-command-runner.sh',
      envVars: {
        MCODE_ROOT_PATH: '/tmp/repo',
        MCODE_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabSetupSplit).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/mcode/issue-command-runner.sh',
      env: {
        MCODE_ROOT_PATH: '/tmp/repo',
        MCODE_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })
  })

  it('queues an issue command split through returned WSL shell metadata', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      runnerScriptPath: 'C:\\repo\\.git\\mcode\\issue-command-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: { MCODE_ROOT_PATH: 'C:\\repo' }
    })

    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /mnt/c/repo/.git/mcode/issue-command-runner.sh',
      env: { MCODE_ROOT_PATH: 'C:\\repo' }
    })
  })

  it('queues both setup split and issue command split when both are provided', () => {
    setSetupScriptLaunchMode('split-vertical')
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      {
        runnerScriptPath: '/tmp/repo/.git/mcode/setup-runner.sh',
        envVars: { MCODE_ROOT_PATH: '/tmp/repo' }
      },
      {
        runnerScriptPath: '/tmp/repo/.git/mcode/issue-command-runner.sh',
        envVars: { MCODE_ROOT_PATH: '/tmp/repo' }
      }
    )

    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabSetupSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/mcode/setup-runner.sh',
      env: { MCODE_ROOT_PATH: '/tmp/repo' },
      direction: 'vertical'
    })
    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/mcode/issue-command-runner.sh',
      env: { MCODE_ROOT_PATH: '/tmp/repo' }
    })
  })

  it('does not queue issue command split when issueCommand is not provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })
})
