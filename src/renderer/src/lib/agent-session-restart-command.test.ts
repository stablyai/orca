import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRestartPane } from './agent-session-restart-plan'
import { createSessionRestartNotifier } from './agent-session-restart-verdict'
import { restartAgentWithConfirmedCommand } from './agent-session-restart-command'

const mocks = vi.hoisted(() => ({ plan: vi.fn(), restart: vi.fn(), state: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.state } }))
vi.mock('./agent-session-restart-service', () => ({
  collectAgentSessionRestartPlanFromState: mocks.plan
}))
vi.mock('./agent-session-restart-mounted', () => ({
  getMountedAgentSessionRestart: () => mocks.restart
}))
const pane: AgentSessionRestartPane = {
  ptyId: 'old',
  tabId: 'tab',
  leafId: '0195f2ce-1111-4000-8000-000000000001',
  worktreeId: 'wt',
  workspaceLabel: 'repo',
  tabGeneration: 1,
  agent: 'claude',
  providerSession: null,
  state: 'done',
  structuredHostOwned: false,
  executionHostId: 'local',
  foreignPty: false,
  wsl: false
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.plan.mockReturnValue({ targets: [{ pane }] })
  mocks.state.mockReturnValue({
    agentStatusByPaneKey: { 'tab:0195f2ce-1111-4000-8000-000000000001': { state: 'done' } }
  })
})
it('runs the explicitly supplied legacy command in the original pane without inventing resume metadata', async () => {
  mocks.restart.mockImplementation((startup) => {
    startup.onSessionRestartSettled({ id: 'new' })
    return true
  })
  const command = "claude --plugin-dir '/path with spaces/plugin' --resume old-session"
  await restartAgentWithConfirmedCommand(pane, command)
  expect(mocks.restart).toHaveBeenCalledWith(
    expect.objectContaining({ command, launchAgent: 'claude' })
  )
  expect(mocks.restart.mock.calls[0][0]).not.toHaveProperty('resumeProviderSession')
})
it('refuses changed ownership or busy agents before stopping a process', async () => {
  mocks.plan.mockReturnValue({ targets: [{ pane: { ...pane, tabGeneration: 2 } }] })
  await expect(restartAgentWithConfirmedCommand(pane, 'claude')).rejects.toThrow('terminal changed')
  mocks.plan.mockReturnValue({ targets: [{ pane }] })
  mocks.state.mockReturnValue({
    agentStatusByPaneKey: { 'tab:0195f2ce-1111-4000-8000-000000000001': { state: 'working' } }
  })
  await expect(restartAgentWithConfirmedCommand(pane, 'claude')).rejects.toThrow('idle')
  expect(mocks.restart).not.toHaveBeenCalled()
})
it('retains the completion callback when cancellation clears startup state', () => {
  const settled = vi.fn()
  let startup: { onSessionRestartSettled?: typeof settled } | null = {
    onSessionRestartSettled: settled
  }
  const notify = createSessionRestartNotifier(() => startup)
  startup = null
  notify(null)
  notify({ id: 'late' })
  expect(settled).toHaveBeenCalledExactlyOnceWith(null)
})
