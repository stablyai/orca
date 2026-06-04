import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from './runtime-terminal-inspection'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

describe('runtime terminal owner routing', () => {
  const runtimeCall = vi.fn()
  const runtimeTransportCall = vi.fn()
  const localWrite = vi.fn()
  const localWriteAccepted = vi.fn()
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
          writeAccepted: localWriteAccepted,
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
        params: {
          terminal: 'terminal-1',
          text: 'x',
          client: { id: 'orca-desktop', type: 'desktop' }
        },
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

  it('treats stale remote terminal handles as gone during process inspection', async () => {
    runtimeCall.mockResolvedValue({
      ok: false,
      error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
    })

    await expect(
      inspectRuntimeTerminalProcess(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-stale'
      )
    ).resolves.toEqual({ foregroundProcess: null, hasChildProcesses: false })
  })

  it('reports stale remote terminal handles as rejected during verified send', async () => {
    runtimeCall.mockResolvedValue({
      ok: false,
      error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
    })

    await expect(
      sendRuntimePtyInputVerified(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-stale',
        'x'
      )
    ).resolves.toBe(false)
  })

  it('reports declined remote terminal sends as rejected during verified send', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      sendRuntimePtyInputVerified(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-1',
        'x'
      )
    ).resolves.toBe(false)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.send',
      params: {
        terminal: 'terminal-1',
        text: 'x',
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      timeoutMs: 15_000
    })
  })

  it('uses accepted local writes for verified input', async () => {
    localWriteAccepted.mockResolvedValue(true)

    await expect(
      sendRuntimePtyInputVerified({ activeRuntimeEnvironmentId: null }, 'local-pty', 'x')
    ).resolves.toBe(true)

    expect(localWriteAccepted).toHaveBeenCalledWith('local-pty', 'x')
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('reports success after fallback fire-and-forget writes when local acceptance cannot be verified', async () => {
    localWriteAccepted.mockResolvedValue(false)

    await expect(
      sendRuntimePtyInputVerified({ activeRuntimeEnvironmentId: null }, 'local-pty', 'x')
    ).resolves.toBe(true)

    expect(localWriteAccepted).toHaveBeenCalledWith('local-pty', 'x')
    expect(localWrite).toHaveBeenCalledWith('local-pty', 'x')
  })
})
