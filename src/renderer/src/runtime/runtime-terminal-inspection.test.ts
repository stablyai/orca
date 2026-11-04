import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimePtyInput } from './runtime-terminal-inspection'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-input-recording'
import { sendRuntimePtyInputVerified } from './runtime-terminal-verified-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../shared/clipboard-text'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/terminal/input/terminal-input'
import { useAppStore } from '../store'
import type { RemoteForegroundEvidence } from '../../../shared/foreground-process-evidence'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

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

    expect(sendRuntimePtyInput('remote:env-1@@terminal-1', 'x', 'driving')).toBe(true)
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

  it('yields while validating large fire-and-forget local input before IPC writes', async () => {
    vi.useFakeTimers()
    try {
      const text = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      expect(sendRuntimePtyInput('local-pty', text, 'driving')).toBe(true)
      expect(localWrite).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(0)

      expect(localWrite).toHaveBeenCalledWith('local-pty', text, 'driving')
      expect(localWriteAccepted).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops byte-oversized fire-and-forget input after deferred validation', async () => {
    vi.useFakeTimers()
    try {
      const text = makeByteOversizedTerminalInput()

      expect(sendRuntimePtyInput('local-pty', text, 'driving')).toBe(true)

      await vi.runAllTimersAsync()

      expect(localWrite).not.toHaveBeenCalled()
      expect(runtimeTransportCall).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('yields while validating large verified local input before IPC writes', async () => {
    vi.useFakeTimers()
    localWriteAccepted.mockResolvedValue(true)
    try {
      const text = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
      const accepted = sendRuntimePtyInputVerified('local-pty', text, 'driving')

      expect(localWriteAccepted).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(0)

      await expect(accepted).resolves.toBe(true)
      expect(localWriteAccepted).toHaveBeenCalledWith('local-pty', text, 'driving')
      expect(localWrite).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects byte-oversized verified input after deferred validation', async () => {
    vi.useFakeTimers()
    try {
      const text = makeByteOversizedTerminalInput()
      const accepted = sendRuntimePtyInputVerified('local-pty', text, 'driving')

      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(false)
      expect(localWriteAccepted).not.toHaveBeenCalled()
      expect(localWrite).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
})
