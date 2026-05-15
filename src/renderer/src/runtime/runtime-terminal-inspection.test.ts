import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectRuntimeTerminalProcess, sendRuntimePtyInput } from './runtime-terminal-inspection'

describe('runtime terminal owner routing', () => {
  const runtimeCall = vi.fn()
  const localWrite = vi.fn()
  const localForeground = vi.fn()
  const localHasChildren = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { process: { foregroundProcess: 'bash', hasChildProcesses: true } },
      _meta: { runtimeId: 'runtime-1' }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeCall },
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
