// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { canonicalSourceControlActionSelection } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { useSavedSourceControlActionStart } from './use-saved-source-control-action-start'

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: launch
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/lib/host-chat-program-acquisition', () => ({
  AgentLaunchChoiceCancelled: class extends Error {},
  acquireAgentLaunchChoices: async () => ({ detected: ['claude'] })
}))
vi.mock('@/runtime/agent-launch-settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: async () => undefined
}))
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('uses the current Claude permission default when a saved action launches after render', async () => {
  const settings = { ...getDefaultSettings('/tmp'), agentPermissionDefault: 'full-access' as const }
  useAppStore.setState({
    settings,
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'child', repoId: TEST_REPO.id })] }
  })
  launch.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'agent' } })
  const { result } = renderHook(() => {
    const saved = useSavedSourceControlActionStart()
    return () =>
      saved.start({
        selection: canonicalSourceControlActionSelection({
          agentId: 'claude',
          surface: 'terminal',
          agentArgs: '--model opus'
        }),
        basePrompt: 'Fix the failed commit',
        actionId: 'fixCommitFailure',
        repo: TEST_REPO,
        repoId: TEST_REPO.id,
        worktreeId: 'child',
        connectionId: null,
        promptDelivery: 'auto-submit',
        launchPlatform: 'linux',
        launchSource: 'source_control_recovery',
        onClose: () => {},
        onFallback: () => {
          throw new Error('Unexpected fallback')
        }
      })
  })
  useAppStore.setState({ settings: { ...settings, agentPermissionDefault: 'ask' } })
  await act(async () => {
    await result.current()
  })
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({ agentArgs: '--permission-mode default --model opus' })
  )
})
