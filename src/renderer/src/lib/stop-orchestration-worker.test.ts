import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { stopOrchestrationWorker } from './stop-orchestration-worker'

const call = vi.fn()

beforeEach(() => {
  vi.stubGlobal('window', { api: { runtime: { call } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  call.mockReset()
  toastError.mockReset()
})

describe('stopOrchestrationWorker', () => {
  it('asks the host’s worker-stop as an orchestration mutation', async () => {
    call.mockResolvedValue({ id: '1', ok: true, result: { state: 'stopped' } })
    await stopOrchestrationWorker('ctx_1')
    expect(call).toHaveBeenCalledWith({
      method: 'orchestration.workerStop',
      params: { dispatch: 'ctx_1' },
      orchestration: {
        contractVersion: ORCHESTRATION_CONTRACT_VERSION,
        requestId: expect.any(String)
      }
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says so when the host could not prove the stop', async () => {
    call.mockResolvedValue({
      id: '1',
      ok: true,
      result: { state: 'stop_unknown', lastError: 'The worker terminal is unproven.' }
    })
    await stopOrchestrationWorker('ctx_1')
    expect(toastError).toHaveBeenCalledWith(expect.any(String), {
      description: 'The worker terminal is unproven.'
    })
  })
})
