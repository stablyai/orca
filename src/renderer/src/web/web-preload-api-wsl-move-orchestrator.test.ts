import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installApi } from './web-preload-api-test-harness'

// D3a-2: a web client never owns a WSL move; its orchestrator API lists nothing and follows nothing.
describe('web preload: WSL move orchestrator', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists no records, never calls back, and leaves the status store empty', async () => {
    const { api } = await installApi()
    expect(await api.wslMove.listOrchestrator()).toEqual([])
    const listener = vi.fn()
    api.wslMove.onOrchestratorStatus(listener)()
    expect(listener).not.toHaveBeenCalled()
    const { followWslMoveOrchestratorStatus, useWslMoveOrchestratorStatus } =
      await import('../components/wsl-move/wsl-move-orchestrator-status')
    const stop = followWslMoveOrchestratorStatus()
    await Promise.resolve()
    expect(useWslMoveOrchestratorStatus.getState().records).toEqual({})
    stop()
  })
})
