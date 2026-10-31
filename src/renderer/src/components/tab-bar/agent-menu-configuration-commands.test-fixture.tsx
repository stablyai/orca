import { act, renderHook } from '@testing-library/react'
import { expect, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { surfaceRowValue } from '@/components/agent/agent-combobox-surface-items'
import { useAgentMenuObservation, type AgentMenuRowsTarget } from './use-new-tab-agent-menu-rows'
import type { readChatProgram, ChatProgramObservation } from '@/lib/host-chat-program'

type ConfigurationMocks = {
  detection: ReturnType<typeof vi.fn>
  program: Mock<(...args: Parameters<typeof readChatProgram>) => ChatProgramObservation | undefined>
}

type ConfigurationWorkMocks = {
  detection: ReturnType<typeof vi.fn>
  candidateVisits: number
  rowVisits: number
  metadata: number
}

export function exerciseAgentMenuConfigurationCommands(mocks: ConfigurationMocks): void {
  const target: AgentMenuRowsTarget = { workspace: { kind: 'git-worktree', repoId: TEST_REPO.id } }
  useAppStore.setState({
    repos: [TEST_REPO],
    detectedAgentIds: null,
    localDetectedAgentIdsByContext: {}
  })
  mocks.program.mockReturnValue('available')
  const cold = {
    detectedIds: null,
    detectionFailed: true,
    isLoading: false,
    isRefreshing: false,
    needsServerUpdate: false
  }
  mocks.detection.mockReturnValue(cold)
  const hook = renderHook(
    ({ config }) => useAgentMenuObservation(target, true, { kind: 'local' }, config),
    { initialProps: { config: true } }
  )
  const model = hook.result.current.model
  expect(model.state).toBe('settled')
  if (model.state !== 'settled') {
    throw new Error('Cold config did not settle')
  }
  expect(model.rows).toContainEqual(expect.objectContaining({ kind: 'cli', agent: 'claude' }))
  expect(model.rows).toContainEqual(expect.objectContaining({ kind: 'chat', agent: 'claude' }))
  expect(model.detection.detectedIds).toBeNull()
  hook.rerender({ config: false })
  expect(hook.result.current.model).toMatchObject({
    rows: expect.not.arrayContaining([expect.objectContaining({ kind: 'cli', agent: 'claude' })])
  })
  for (const override of [
    { detectedIds: [] },
    { isLoading: true },
    { isRefreshing: true },
    { needsServerUpdate: true },
    { detectionFailed: false }
  ]) {
    mocks.detection.mockReturnValue({ ...cold, ...override })
    hook.rerender({ config: true })
    const next = hook.result.current.model
    if (next.state === 'settled') {
      expect(next.rows).not.toContainEqual(
        expect.objectContaining({ kind: 'cli', agent: 'claude' })
      )
    }
  }
}

export async function exerciseAgentMenuConfigurationCommandWork(
  mocks: ConfigurationWorkMocks
): Promise<void> {
  const work: { candidates: number; rows: number; built: number; selections: number }[] = []
  for (const count of [10, 100]) {
    useAppStore.setState({
      repos: [TEST_REPO],
      detectedAgentIds: null,
      localDetectedAgentIdsByContext: {}
    })
    mocks.detection.mockReturnValue({
      detectedIds: null,
      detectionFailed: true,
      isLoading: false,
      isRefreshing: false,
      needsServerUpdate: false
    })
    const target: AgentMenuRowsTarget = {
      workspace: { kind: 'git-worktree', repoId: TEST_REPO.id }
    }
    let renders = 0
    const hooks = Array.from({ length: count }, () =>
      renderHook(() => {
        renders++
        return useAgentMenuObservation(target, true, { kind: 'local' }, true)
      })
    )
    await act(async () => {})
    mocks.candidateVisits = 0
    mocks.rowVisits = 0
    mocks.metadata = 0
    for (const hook of hooks) {
      hook.rerender()
    }
    const candidates = mocks.candidateVisits,
      rows = mocks.rowVisits,
      built = mocks.metadata
    let selections = 0
    for (const hook of hooks) {
      const model = hook.result.current.model
      if (model.state !== 'settled') {
        throw new Error('Configuration rows did not settle')
      }
      for (const row of model.rows) {
        const agent = row.agent
        Object.defineProperty(row, 'agent', {
          configurable: true,
          get: () => {
            selections++
            return agent
          }
        })
      }
      for (const agent of ['claude', 'codex'] as const) {
        hook.result.current.selectionFor(agent, 'terminal')
        surfaceRowValue(model.rows, agent, true)
      }
    }
    work.push({ candidates, rows, built, selections })
    const settled = renders
    act(() => useAppStore.setState({ settingsSearchQuery: 'unrelated' }))
    expect(renders).toBe(settled)
    act(() => useAppStore.setState({ remoteDetectedAgentIds: { other: ['claude'] } }))
    expect(renders).toBe(settled)
    Object.assign(window, {
      api: {
        ...window.api,
        preflight: {
          ...window.api?.preflight,
          detectRemoteAgents: vi.fn().mockRejectedValue(new Error('other host failed'))
        }
      }
    })
    await act(() => useAppStore.getState().ensureRemoteDetectedAgents('other-failed'))
    expect(renders).toBe(settled)
    mocks.detection.mockReturnValue({ detectedIds: null, detectionFailed: false, isLoading: true })
    for (const hook of hooks) {
      hook.rerender()
    }
    expect(renders).toBeGreaterThan(settled)
    for (const hook of hooks) {
      hook.unmount()
    }
  }
  console.info('configuration command work', work)
  for (const key of ['candidates', 'rows', 'built', 'selections'] as const) {
    expect(work[0][key]).toBeGreaterThan(0)
    expect(work[1][key]).toBe(10 * work[0][key])
  }
}
