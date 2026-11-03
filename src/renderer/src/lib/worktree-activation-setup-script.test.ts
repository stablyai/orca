import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset,
  createdTabStartups
} from './worktree-activation.test-fixture'

registerWorktreeActivationReset()

function setCloseSetupTabOnSuccess(closeSetupTabOnSuccess: boolean): void {
  useAppStore.setState((state) => ({
    settings: {
      ...(state.settings ?? getDefaultSettings('')),
      closeSetupTabOnSuccess,
      terminalWindowsShell: ''
    }
  }))
}

describe('ensureWorktreeHasInitialTerminal', () => {
  it('makes the setup tab exit its shell on success when auto-close is on', () => {
    setCloseSetupTabOnSuccess(true)
    try {
      const setup = {
        runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
        shell: { family: 'cmd' as const },
        envVars: {}
      }
      let createdIndex = 0
      const newTabStore = createMockStore({
        createTab: vi.fn(() => ({ id: `tab-${++createdIndex}` }))
      })
      ensureWorktreeHasInitialTerminal(newTabStore, 'wt-1', undefined, setup)
      expect(createdTabStartups(newTabStore)['tab-2']).toEqual({
        command:
          'cmd.exe /c "C:\\repo\\.git\\orca\\setup-runner.cmd"; if ($LASTEXITCODE -eq 0) { exit }',
        env: {}
      })

      createdIndex = 0
      const posixStore = createMockStore({
        createTab: vi.fn(() => ({ id: `tab-${++createdIndex}` }))
      })
      ensureWorktreeHasInitialTerminal(posixStore, 'wt-1', undefined, {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: {}
      })
      expect(createdTabStartups(posixStore)['tab-2']).toEqual({
        command: 'bash /tmp/repo/.git/orca/setup-runner.sh && exit',
        env: {}
      })
    } finally {
      setCloseSetupTabOnSuccess(false)
    }
  })
})
