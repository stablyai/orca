import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectRuntimeTerminalProcess,
  recordRuntimeTerminalInputForPtyId,
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from './runtime-terminal-inspection'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../shared/clipboard-text'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/terminal-input'
import { useAppStore } from '../store'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function makeByteOversizedTerminalInput(): string {
  return '😀'.repeat(Math.floor(TERMINAL_INPUT_MAX_BYTES / 4) + 1)
}

describe('runtime terminal owner routing', () => {
  const runtimeCall = vi.fn()
  const runtimeTransportCall = vi.fn()
  const localWrite = vi.fn()
  const localWriteAccepted = vi.fn()
  const localForeground = vi.fn()
  const localHasChildren = vi.fn()
  const localInspect = vi.fn()

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
          hasChildProcesses: localHasChildren,
          inspectProcess: localInspect
        }
      }
    })
    useAppStore.setState({
      settings: { experimentalAgentHibernation: true } as never,
      terminalLayoutsByTabId: {},
      lastTerminalInputAtByPaneKey: {}
    })
  })

  it('records runtime input markers even before hibernation is enabled', () => {
    useAppStore.setState({
      settings: { experimentalAgentHibernation: false } as never,
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'local-pty' }
        }
      }
    })

    recordRuntimeTerminalInputForPtyId('local-pty', 123)

    expect(useAppStore.getState().lastTerminalInputAtByPaneKey[PANE_KEY]).toBe(123)
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

  it('uses strict main-process inspection for a direct SSH PTY', async () => {
    localInspect.mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: true })

    await expect(inspectRuntimeTerminalProcess(null, 'ssh:host@@pty-1')).resolves.toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true
    })
    expect(localInspect).toHaveBeenCalledExactlyOnceWith('ssh:host@@pty-1')
    expect(localForeground).not.toHaveBeenCalled()
    expect(localHasChildren).not.toHaveBeenCalled()
  })

  it.each(['no_connected_pty', 'terminal_handle_stale', 'terminal_gone'])(
    'reports %s remote process inspection as unavailable',
    async (code) => {
      runtimeCall.mockResolvedValue({
        ok: false,
        error: { code, message: code }
      })

      await expect(
        inspectRuntimeTerminalProcess(
          { activeRuntimeEnvironmentId: 'env-2' },
          'remote:env-1@@terminal-stale'
        )
      ).resolves.toEqual({ foregroundProcess: null, hasChildProcesses: false, unavailable: true })
    }
  )

  it('records accepted fire-and-forget runtime input against the owning pane key', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } },
      _meta: { runtimeId: 'runtime-1' }
    })
    useAppStore.setState({
      settings: { experimentalAgentHibernation: true } as never,
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-1@@terminal-1' }
        }
      }
    })

    expect(
      sendRuntimePtyInput({ activeRuntimeEnvironmentId: 'env-2' }, 'remote:env-1@@terminal-1', 'x')
    ).toBe(true)

    await vi.waitFor(() => {
      expect(useAppStore.getState().lastTerminalInputAtByPaneKey[PANE_KEY]).toEqual(
        expect.any(Number)
      )
    })
  })

  it('does not record declined fire-and-forget runtime input', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } },
      _meta: { runtimeId: 'runtime-1' }
    })
    useAppStore.setState({
      settings: { experimentalAgentHibernation: true } as never,
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-1@@terminal-1' }
        }
      }
    })

    expect(
      sendRuntimePtyInput({ activeRuntimeEnvironmentId: 'env-2' }, 'remote:env-1@@terminal-1', 'x')
    ).toBe(true)

    await vi.waitFor(() => {
      expect(runtimeCall).toHaveBeenCalled()
    })
    expect(useAppStore.getState().lastTerminalInputAtByPaneKey[PANE_KEY]).toBeUndefined()
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

  it('rejects oversized fire-and-forget local input before IPC writes', () => {
    const text = 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1)

    expect(sendRuntimePtyInput({ activeRuntimeEnvironmentId: null }, 'local-pty', text)).toBe(false)

    expect(localWrite).not.toHaveBeenCalled()
    expect(localWriteAccepted).not.toHaveBeenCalled()
  })

  it('rejects oversized fire-and-forget remote input before runtime RPC', () => {
    const text = 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1)

    expect(
      sendRuntimePtyInput({ activeRuntimeEnvironmentId: 'env-2' }, 'remote:env-1@@terminal-1', text)
    ).toBe(false)

    expect(runtimeTransportCall).not.toHaveBeenCalled()
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('yields while validating large fire-and-forget local input before IPC writes', async () => {
    vi.useFakeTimers()
    try {
      const text = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      expect(sendRuntimePtyInput({ activeRuntimeEnvironmentId: null }, 'local-pty', text)).toBe(
        true
      )
      expect(localWrite).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(0)

      expect(localWrite).toHaveBeenCalledWith('local-pty', text)
      expect(localWriteAccepted).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops byte-oversized fire-and-forget input after deferred validation', async () => {
    vi.useFakeTimers()
    try {
      const text = makeByteOversizedTerminalInput()

      expect(sendRuntimePtyInput({ activeRuntimeEnvironmentId: null }, 'local-pty', text)).toBe(
        true
      )

      await vi.runAllTimersAsync()

      expect(localWrite).not.toHaveBeenCalled()
      expect(runtimeTransportCall).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized verified input before fallback fire-and-forget writes', async () => {
    const text = 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1)

    await expect(
      sendRuntimePtyInputVerified({ activeRuntimeEnvironmentId: null }, 'local-pty', text)
    ).resolves.toBe(false)

    expect(localWriteAccepted).not.toHaveBeenCalled()
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('yields while validating large verified local input before IPC writes', async () => {
    vi.useFakeTimers()
    localWriteAccepted.mockResolvedValue(true)
    try {
      const text = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
      const accepted = sendRuntimePtyInputVerified(
        { activeRuntimeEnvironmentId: null },
        'local-pty',
        text
      )

      expect(localWriteAccepted).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(0)

      await expect(accepted).resolves.toBe(true)
      expect(localWriteAccepted).toHaveBeenCalledWith('local-pty', text)
      expect(localWrite).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects byte-oversized verified input after deferred validation', async () => {
    vi.useFakeTimers()
    try {
      const text = makeByteOversizedTerminalInput()
      const accepted = sendRuntimePtyInputVerified(
        { activeRuntimeEnvironmentId: null },
        'local-pty',
        text
      )

      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(false)
      expect(localWriteAccepted).not.toHaveBeenCalled()
      expect(localWrite).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records accepted runtime input against the owning pane key', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } },
      _meta: { runtimeId: 'runtime-1' }
    })
    useAppStore.setState({
      settings: { experimentalAgentHibernation: true } as never,
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-1@@terminal-1' }
        }
      }
    })

    await expect(
      sendRuntimePtyInputVerified(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-1',
        'x'
      )
    ).resolves.toBe(true)

    expect(useAppStore.getState().lastTerminalInputAtByPaneKey[PANE_KEY]).toEqual(
      expect.any(Number)
    )
  })

  it('does not record rejected runtime input against the owning pane key', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } },
      _meta: { runtimeId: 'runtime-1' }
    })
    useAppStore.setState({
      settings: { experimentalAgentHibernation: true } as never,
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-1@@terminal-1' }
        }
      }
    })

    await expect(
      sendRuntimePtyInputVerified(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-1',
        'x'
      )
    ).resolves.toBe(false)

    expect(useAppStore.getState().lastTerminalInputAtByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('can record a runtime input marker from a PTY id mapping', () => {
    useAppStore.setState({
      settings: { experimentalAgentHibernation: true } as never,
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'local-pty' }
        }
      }
    })

    recordRuntimeTerminalInputForPtyId('local-pty', 123)

    expect(useAppStore.getState().lastTerminalInputAtByPaneKey[PANE_KEY]).toBe(123)
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
