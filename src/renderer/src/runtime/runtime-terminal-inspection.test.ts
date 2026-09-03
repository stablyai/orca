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
import type { RemoteForegroundEvidence } from '../../../shared/foreground-process-evidence'
import {
  clientOnlyUnverifiableInspection,
  type ClientOnlyUnverifiableInspection
} from '../../../shared/terminal-process-inspection'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function makeByteOversizedTerminalInput(): string {
  return '😀'.repeat(Math.floor(TERMINAL_INPUT_MAX_BYTES / 4) + 1)
}

function liveEvidence(ptyId: string, processName = 'bash'): RemoteForegroundEvidence {
  return {
    authorityGeneration: 'authority-1',
    observationEpoch: 1,
    capturedAgeMs: 0,
    ptyId,
    ptyIncarnationId: 'incarnation-1',
    verdict: 'live',
    processName,
    fence: {
      platform: 'posix',
      shellPid: 1,
      shellStartTime: '1',
      tty: '/dev/pts/1',
      foregroundPgid: 1
    }
  }
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
      result: {
        process: {
          foregroundProcess: 'bash',
          hasChildProcesses: true,
          foregroundProcessEvidence: liveEvidence('terminal-1')
        }
      },
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
    ).resolves.toMatchObject({ foregroundProcess: 'bash', hasChildProcesses: true })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.inspectProcess',
      params: { terminal: 'terminal-1' },
      timeoutMs: 15_000
    })
    expect(localForeground).not.toHaveBeenCalled()
    expect(localHasChildren).not.toHaveBeenCalled()
  })

  it('maps an old host inspection to client-only unverifiable', async () => {
    runtimeCall.mockResolvedValue({
      ok: true,
      result: {
        process: { foregroundProcess: 'codex', hasChildProcesses: true }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      inspectRuntimeTerminalProcess(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-1'
      )
    ).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable',
      reason: 'old_host'
    })
  })

  it('uses strict main-process inspection for a direct SSH PTY', async () => {
    localInspect.mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      foregroundProcessEvidence: liveEvidence('pty-1', 'codex')
    })

    await expect(inspectRuntimeTerminalProcess(null, 'ssh:host@@pty-1')).resolves.toMatchObject({
      foregroundProcess: 'codex',
      hasChildProcesses: true
    })
    expect(localInspect).toHaveBeenCalledExactlyOnceWith('ssh:host@@pty-1')
    expect(localForeground).not.toHaveBeenCalled()
    expect(localHasChildren).not.toHaveBeenCalled()
  })

  it('maps an old direct SSH host to client-only unverifiable', async () => {
    localInspect.mockResolvedValue({
      foregroundProcess: null,
      hasChildProcesses: true
    })

    await expect(inspectRuntimeTerminalProcess(null, 'ssh:host@@pty-1')).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable',
      reason: 'old_host'
    })
  })

  it.each(['no_connected_pty', 'terminal_handle_stale', 'terminal_gone'])(
    'reports %s remote process inspection as client-only unverifiable',
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
      ).resolves.toEqual({
        foregroundProcess: null,
        hasChildProcesses: false,
        verdict: 'unverifiable',
        reason: 'terminal_gone'
      })
    }
  )

  it('maps lost contact and timeout to client-only unverifiable results', async () => {
    runtimeCall.mockRejectedValueOnce(new Error('SSH connection lost, reconnecting...'))
    await expect(
      inspectRuntimeTerminalProcess(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-transport'
      )
    ).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable',
      reason: 'transport_loss'
    })

    runtimeCall.mockRejectedValueOnce(new Error('Request timed out before completion'))
    await expect(
      inspectRuntimeTerminalProcess(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-timeout'
      )
    ).resolves.toMatchObject({ verdict: 'unverifiable', reason: 'timeout' })
  })

  it('keeps client-only unverifiable free of host metadata', () => {
    type HostFieldsCannotBeConstructed = ClientOnlyUnverifiableInspection extends {
      authorityGeneration?: never
      observationEpoch?: never
      capturedAgeMs?: never
      ptyId?: never
      ptyIncarnationId?: never
    }
      ? true
      : false
    const typeProof: HostFieldsCannotBeConstructed = true
    expect(typeProof).toBe(true)
    const result = clientOnlyUnverifiableInspection('transport_loss')
    expect(result).not.toHaveProperty('authorityGeneration')
    expect(result).not.toHaveProperty('foregroundProcessEvidence')
  })

  it('still throws an unclassified programming error', async () => {
    runtimeCall.mockRejectedValueOnce(new Error('inspection invariant violated'))
    await expect(
      inspectRuntimeTerminalProcess(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-bug'
      )
    ).rejects.toThrow('inspection invariant violated')
  })

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

  it('attributes a delayed runtime acknowledgement to the current layout owner', async () => {
    const pendingSend = Promise.withResolvers<{
      ok: true
      result: { send: { handle: string; accepted: true; bytesWritten: number } }
      _meta: { runtimeId: string }
    }>()
    runtimeCall.mockReturnValue(pendingSend.promise)
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-1@@terminal-1' }
        }
      }
    })
    recordRuntimeTerminalInputForPtyId('remote:env-1@@terminal-1', 123)
    useAppStore.setState({ lastTerminalInputAtByPaneKey: {} })

    expect(
      sendRuntimePtyInput({ activeRuntimeEnvironmentId: 'env-2' }, 'remote:env-1@@terminal-1', 'x')
    ).toBe(true)
    const nextLeafId = '22222222-2222-4222-8222-222222222222'
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-2': {
          root: { type: 'leaf', leafId: nextLeafId },
          activeLeafId: nextLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [nextLeafId]: 'remote:env-1@@terminal-1' }
        }
      }
    })
    pendingSend.resolve({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } },
      _meta: { runtimeId: 'runtime-1' }
    })

    await vi.waitFor(() => {
      expect(useAppStore.getState().lastTerminalInputAtByPaneKey).toEqual({
        [`tab-2:${nextLeafId}`]: expect.any(Number)
      })
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

  it('indexes a stable layout identity once across repeated terminal input', () => {
    const layoutCount = 500
    let layoutEnumerations = 0
    let leafEnumerations = 0
    const layouts = Object.fromEntries(
      Array.from({ length: layoutCount }, (_, index) => {
        const leafId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
        const ptyIdsByLeafId = new Proxy(
          { [leafId]: `pty-${index}` },
          {
            ownKeys: (target) => {
              leafEnumerations += 1
              return Reflect.ownKeys(target)
            }
          }
        )
        return [
          `tab-${index}`,
          {
            root: { type: 'leaf' as const, leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId
          }
        ]
      })
    )
    const observedLayouts = new Proxy(layouts, {
      ownKeys: (target) => {
        layoutEnumerations += 1
        return Reflect.ownKeys(target)
      }
    })
    useAppStore.setState({ terminalLayoutsByTabId: observedLayouts })

    recordRuntimeTerminalInputForPtyId('pty-0', 10_000)
    expect({ layoutEnumerations, leafEnumerations }).toEqual({
      layoutEnumerations: 1,
      leafEnumerations: 1
    })
    layoutEnumerations = 0
    leafEnumerations = 0

    for (let timestamp = 1; timestamp <= 100; timestamp += 1) {
      recordRuntimeTerminalInputForPtyId(`pty-${layoutCount - 1}`, timestamp * 10_000)
    }

    expect({ layoutEnumerations, leafEnumerations }).toEqual({
      layoutEnumerations: 1,
      leafEnumerations: layoutCount
    })
    expect(
      useAppStore.getState().lastTerminalInputAtByPaneKey[
        `tab-${layoutCount - 1}:00000000-0000-4000-8000-${(layoutCount - 1)
          .toString(16)
          .padStart(12, '0')}`
      ]
    ).toBe(1_000_000)
  })

  it('reindexes a PTY when the immutable layout identity changes', () => {
    const nextLeafId = '22222222-2222-4222-8222-222222222222'
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'rebound-pty' }
        }
      }
    })
    recordRuntimeTerminalInputForPtyId('rebound-pty', 123)

    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-2': {
          root: { type: 'leaf', leafId: nextLeafId },
          activeLeafId: nextLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [nextLeafId]: 'rebound-pty' }
        }
      }
    })
    recordRuntimeTerminalInputForPtyId('rebound-pty', 1_000)

    expect(useAppStore.getState().lastTerminalInputAtByPaneKey).toEqual({
      [PANE_KEY]: 123,
      [`tab-2:${nextLeafId}`]: 1_000
    })
  })

  it('reindexes stale owners without caching misses within the same layout identity', () => {
    const nextLeafId = '22222222-2222-4222-8222-222222222222'
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'rebound-pty' }
        }
      }
    })
    const layouts = useAppStore.getState().terminalLayoutsByTabId
    recordRuntimeTerminalInputForPtyId('rebound-pty', 123)
    recordRuntimeTerminalInputForPtyId('late-pty', 456)

    const firstLayout = layouts['tab-1']
    expect(firstLayout).toBeDefined()
    if (!firstLayout) {
      return
    }
    firstLayout.ptyIdsByLeafId = Object.create({ [LEAF_ID]: 'rebound-pty' })
    Object.setPrototypeOf(layouts, { 'tab-1': firstLayout })
    delete layouts['tab-1']
    layouts['tab-2'] = {
      root: { type: 'leaf', leafId: nextLeafId },
      activeLeafId: nextLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [nextLeafId]: 'rebound-pty', [LEAF_ID]: 'late-pty' }
    }
    recordRuntimeTerminalInputForPtyId('rebound-pty', 1_000)
    recordRuntimeTerminalInputForPtyId('late-pty', 2_000)

    expect(useAppStore.getState().terminalLayoutsByTabId).toBe(layouts)
    expect(useAppStore.getState().lastTerminalInputAtByPaneKey).toEqual({
      [PANE_KEY]: 123,
      [`tab-2:${nextLeafId}`]: 1_000,
      [`tab-2:${LEAF_ID}`]: 2_000
    })
  })

  it('preserves a malformed first match instead of routing a duplicate PTY', () => {
    const nextLeafId = '22222222-2222-4222-8222-222222222222'
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'legacy:tab': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'duplicate-pty' }
        },
        'tab-2': {
          root: { type: 'leaf', leafId: nextLeafId },
          activeLeafId: nextLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [nextLeafId]: 'duplicate-pty' }
        }
      }
    })

    recordRuntimeTerminalInputForPtyId('duplicate-pty', 123)

    expect(useAppStore.getState().lastTerminalInputAtByPaneKey).toEqual({})
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
