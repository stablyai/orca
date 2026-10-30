import { vi } from 'vitest'
import { resetAgentStartupDelayedDeliveryForTests } from '@/lib/agent-startup-delayed-delivery'
import * as agentStatusStartupSnapshot from '@/hooks/ipc-events/agent-status-startup-snapshot'
import { drainFakeTimerWork, flushAsyncTicks } from './pty-connection-test-async'
import { takeTerminalTestPanes } from './pty-connection-test-pane-fixtures'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'

const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
const originalDocument = globalThis.document
type StatusSnapshot = ReturnType<
  typeof agentStatusStartupSnapshot.registerAgentStatusStartupSnapshot
>
let statusSnapshot: StatusSnapshot | undefined
let resetStatusSnapshot: StatusSnapshot | undefined

export function buildAgentStatusModuleMock(
  actual: Record<string, unknown>
): Record<string, unknown> {
  const isGeminiTerminalTitle = actual.isGeminiTerminalTitle as (title: string) => boolean
  return {
    ...actual,
    isGeminiTerminalTitle: vi.fn((title: string) => isGeminiTerminalTitle(title)),
    isClaudeAgent: vi.fn(() => false),
    detectAgentStatusFromTitle: vi.fn((title: string) => {
      if (/Claude (working|done)/.test(title)) {
        return /working/.test(title) ? 'working' : 'idle'
      }
      if (/Codex( working)?/.test(title)) {
        return /working/.test(title) ? 'working' : 'idle'
      }
      if (/^\s*(?:[\u2800-\u28ff]\s+)?(?:Pi|OMP)(?: ready| idle)?\s*$/i.test(title)) {
        return /[\u2800-\u28ff]/u.test(title) ? 'working' : 'idle'
      }
      return null
    })
  }
}

export async function installTerminalTestGlobals(): Promise<void> {
  statusSnapshot?.dispose()
  resetStatusSnapshot?.dispose()
  statusSnapshot = agentStatusStartupSnapshot.registerAgentStatusStartupSnapshot()
  statusSnapshot.settle()
  resetStatusSnapshot = undefined
  // Import after resetModules so the seeded store and connection share one bridge.
  const actual = await import('@/hooks/ipc-events/agent-status-startup-snapshot')
  resetStatusSnapshot = actual.registerAgentStatusStartupSnapshot()
  resetStatusSnapshot.settle()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      ssh: {
        connect: vi.fn().mockResolvedValue({ status: 'connected' }),
        needsPassphrasePrompt: vi.fn().mockResolvedValue(false)
      },
      pty: {
        kill: vi.fn(),
        signal: vi.fn(),
        listSessions: vi.fn().mockResolvedValue([]),
        hasPty: vi.fn().mockResolvedValue(true),
        getSize: vi.fn().mockResolvedValue(null),
        reportGeometry: vi.fn(),
        getMainBufferSnapshot: vi.fn().mockResolvedValue(null),
        getForegroundProcess: vi.fn().mockResolvedValue(null),
        inspectProcess: vi.fn(),
        confirmForegroundProcess: vi.fn().mockResolvedValue(null),
        hasChildProcesses: vi.fn().mockResolvedValue(false),
        write: vi.fn(),
        writeAccepted: vi.fn().mockResolvedValue(true),
        setHiddenRendererPty: vi.fn(),
        setPtyDeliveryInterest: vi.fn(),
        ackColdRestore: vi.fn(),
        ackHiddenOutputRestoreApplied: vi.fn(),
        onClearBufferRequest: vi.fn(() => vi.fn()),
        onResetInputModesRequest: vi.fn(() => vi.fn()),
        resetInputModes: vi.fn(),
        onSerializeBufferRequest: vi.fn(() => vi.fn()),
        sendSerializedBuffer: vi.fn(),
        declarePendingPaneSerializer: vi.fn().mockResolvedValue(1),
        settlePaneSerializer: vi.fn().mockResolvedValue(undefined),
        clearPendingPaneSerializer: vi.fn().mockResolvedValue(undefined),
        reportRendererSerializerReady: vi.fn().mockResolvedValue(undefined)
      },
      platform: {
        get: vi.fn(() => ({ platform: 'win32', osRelease: '10.0.26100' }))
      },
      notifications: {
        dispatch: vi.fn().mockResolvedValue({ delivered: true }),
        playSound: vi.fn().mockResolvedValue({ played: true })
      },
      runtime: {
        restoreTerminalFit: vi.fn().mockResolvedValue({ restored: true })
      },
      agentStatus: {
        inferInterrupt: vi.fn().mockResolvedValue(false),
        reconcileEndedProcess: vi.fn()
      }
    },
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
  vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation((id) =>
    window.api.pty.getForegroundProcess(id)
  )
  vi.mocked(window.api.pty.inspectProcess).mockImplementation(async (id) => {
    const foregroundProcess = await window.api.pty.getForegroundProcess(id)
    const hasChildProcesses = await window.api.pty.hasChildProcesses(id)
    return { foregroundProcess, hasChildProcesses }
  })
  globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  globalThis.cancelAnimationFrame = vi.fn()
}

export async function restoreTerminalTestGlobals(): Promise<void> {
  // Drain deferred confirmation work before the next test replaces its store mock.
  await drainFakeTimerWork()
  vi.useRealTimers()
  // Flush real-promise settle continuations while window still exists; fake timers postpone them beyond teardown (orca#14728).
  await flushAsyncTicks(20)
  const { cancelPendingSafeFitContinuations } =
    await import('@/lib/pane-manager/pane-fit-continuation-registry')
  for (const pane of takeTerminalTestPanes()) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture panes provide the fit and terminal members read during cancellation.
    cancelPendingSafeFitContinuations(pane as unknown as ManagedPane)
  }
  await flushAsyncTicks(20)
  statusSnapshot?.dispose()
  resetStatusSnapshot?.dispose()
  statusSnapshot = undefined
  resetStatusSnapshot = undefined
  vi.restoreAllMocks()
  if (originalRequestAnimationFrame) {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
  } else {
    delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
      .requestAnimationFrame
  }
  if (originalCancelAnimationFrame) {
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  } else {
    delete (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame })
      .cancelAnimationFrame
  }
  if (originalDocument) {
    globalThis.document = originalDocument
  } else {
    delete (globalThis as { document?: Document }).document
  }
  // Late reattach continuations can outlive teardown; keep an inert window like a real renderer until the next test installs its replacement (orca#14728).
  ;(globalThis as unknown as { window?: unknown }).window = { api: createInertApi() }
  delete (globalThis as Record<string, unknown>).__ptyConnectDiag
  resetAgentStartupDelayedDeliveryForTests()
}

/** Any property resolves to another inert callable; any call resolves to undefined. */
function createInertApi(): unknown {
  return new Proxy(() => {}, {
    // `then` must stay undefined so awaiting a returned value cannot recurse.
    get: (_target, property) => (property === 'then' ? undefined : createInertApi()),
    apply: () => Promise.resolve(undefined)
  })
}
