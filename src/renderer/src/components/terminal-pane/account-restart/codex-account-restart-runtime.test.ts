import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { createGlobalSettingsFixture } from '../../../../../shared/settings/global-settings-test-fixture'
import { seed, key } from './codex-account-restart.test-fixture'
const capabilities = vi.hoisted((): { wslAvailable: boolean; wslDistros: string[] } => ({
  wslAvailable: false,
  wslDistros: []
}))
vi.mock('@/app-shell/platform/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'win32'
}))
vi.mock('@/runtime/hosts/capabilities/windows-terminal-capabilities', () => ({
  hasCachedWindowsTerminalCapabilities: () => true,
  getCachedWindowsTerminalCapabilities: () => capabilities
}))
vi.mock('@/lib/agent-session/accounts/agent-account-restart-startup', () => ({
  captureAgentAccountRestartResumeInput: () => null,
  buildPaneAccountRestartStartup: () => ({ command: 'codex', launchAgent: 'codex' })
}))
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.stubGlobal('window', { api: {} })
  seed()
})
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('captures known WSL repair facts when availability is %s', (available) => {
  capabilities.wslAvailable = available
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id, path: 'C:\\repo' })]
    },
    settings: createGlobalSettingsFixture({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Missing' }
    })
  })
  useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
  const request = useAppStore.getState().pendingPaneAccountRestarts[key]
  expect(typeof request === 'object' && request.projectRuntime).toMatchObject({
    status: 'repair-required',
    repair: { reason: available ? 'wsl-distro-missing' : 'wsl-unavailable' }
  })
})
