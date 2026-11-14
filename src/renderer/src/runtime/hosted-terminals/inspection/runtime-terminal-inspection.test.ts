import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimePtyInput } from '../input/runtime-terminal-input-send'
import { recordRuntimeTerminalInputForPtyId } from '../input/runtime-terminal-input-recording'
import { sendRuntimePtyInputVerified } from '../input/runtime-terminal-verified-input'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../rpc/compatibility/runtime-compatibility-cache'
import { useAppStore } from '../../../store/index'
import type { RemoteForegroundEvidence } from '../../../../../shared/foreground-process-evidence'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeByteOversizedTerminalInput(): string {
  return '😀'.repeat(4_194_305)
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

  afterEach(() => {
    vi.restoreAllMocks()
  })

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
    vi.spyOn(Date, 'now').mockReturnValue(456_000)
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
        'tab-2:22222222-2222-4222-8222-222222222222': 456_000
      })
    })
  })

  it('drops byte-oversized fire-and-forget input after deferred validation', async () => {
    vi.useFakeTimers()
    try {
      const text = makeByteOversizedTerminalInput()

      expect(sendRuntimePtyInput('local-pty', text, 'driving')).toBe(true)

      await vi.runAllTimersAsync()

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
})
