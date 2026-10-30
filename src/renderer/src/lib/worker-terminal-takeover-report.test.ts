import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { reportWorkerTerminalUserInput } from './worker-terminal-takeover-report'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

describe('reportWorkerTerminalUserInput', () => {
  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset().mockResolvedValue({ changed: 1 })
  })

  it('throttles per runtime target so a rebound pane reports to its new owner', () => {
    reportWorkerTerminalUserInput('pane-runtime-rebind', null)
    reportWorkerTerminalUserInput('pane-runtime-rebind', null)
    reportWorkerTerminalUserInput('pane-runtime-rebind', 'runtime-remote')
    reportWorkerTerminalUserInput('pane-runtime-rebind', 'runtime-remote')

    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'local' },
      'orchestration.workerTerminalUserInput',
      { paneKey: 'pane-runtime-rebind' },
      { suppressFeatureInteraction: true, reuseRecentCompatibilityFailure: true }
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'runtime-remote' },
      'orchestration.workerTerminalUserInput',
      { paneKey: 'pane-runtime-rebind' },
      { suppressFeatureInteraction: true, reuseRecentCompatibilityFailure: true }
    )
  })
})
