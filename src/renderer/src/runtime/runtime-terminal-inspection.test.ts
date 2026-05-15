import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectRuntimeTerminalProcess, sendRuntimePtyInput } from './runtime-terminal-inspection'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

describe('runtime terminal owner routing', () => {
  const runtimeCall = vi.fn()
  const runtimeTransportCall = vi.fn()
  const localWrite = vi.fn()
  const localForeground = vi.fn()
  const localHasChildren = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { process: { foregroundProcess: 'bash', hasChildProcesses: true } },
      _meta: { runtimeId: 'runtime-1' }
    })
    runtimeTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeTransportCall },
        pty: {
          write: localWrite,
          getForegroundProcess: localForeground,
          hasChildProcesses: localHasChildren
        }
      }
    })
  })

  it('sends input through the PTY owning environment instead of the active one', async () => {
    expect(
      sendRuntimePtyInput({ activeRuntimeEnvironmentId: 'env-2' }, 'remote:env-1@@terminal-1', 'x')
    ).toBe(true)

    await vi.waitFor(() => {
      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'terminal.send',
        params: { terminal: 'terminal-1', text: 'x' },
        timeoutMs: 15_000
      })
    })
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('inspects the PTY owning environment instead of the active one', async () => {
    await expect(
      inspectRuntimeTerminalProcess(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-1'
      )
    ).resolves.toEqual({ foregroundProcess: 'bash', hasChildProcesses: true })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.inspectProcess',
      params: { terminal: 'terminal-1' },
      timeoutMs: 15_000
    })
    expect(localForeground).not.toHaveBeenCalled()
    expect(localHasChildren).not.toHaveBeenCalled()
  })
})
