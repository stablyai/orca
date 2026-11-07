import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { GENERATED_INPUT_RUNTIME_CAPABILITY } from '../../../shared/generated-terminal-input'
import {
  GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY,
  GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY
} from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ ptyIdsByTabId: {}, tabsByWorktree: {}, terminalLayoutsByTabId: {} }),
    subscribe: () => () => {}
  }
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: () => 'codex' }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), dismiss: vi.fn() } }))

const { sendGeneratedTerminalInputToHandle } =
  await import('@/runtime/generated-terminal-input-client')
const { getRuntimeEnvironmentCapabilityStatus } = await import('@/runtime/runtime-rpc-client')
const { clearRuntimeCompatibilityCache } = await import('@/runtime/runtime-compatibility-cache')
const { sendPromptWithLegacyCombinedSend } = await import('./active-agent-note-send-delivery')

const SEND = 'terminal.sendGeneratedInput'
const status = (runtimeId: string, capabilities: string[]) => ({
  runtimeId,
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  capabilities
})
const answer = (result: unknown, runtimeId = 'h1') => ({
  id: 'x',
  ok: true,
  result,
  _meta: { runtimeId }
})

// One accepted generated request against a paired host: the real client, status selection,
// compatibility cache, RPC client, legacy source, writer and shared operation. Only the IPC to
// main is a stand-in, answering as main would for that host.
let hostCall: ReturnType<typeof vi.fn>
let hostSubscribe: ReturnType<typeof vi.fn>
beforeEach(() => {
  hostCall = vi.fn()
  hostSubscribe = vi.fn()
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    api: { runtimeEnvironments: { call: hostCall, subscribe: hostSubscribe } }
  })
})
afterEach(() => {
  clearRuntimeCompatibilityCache()
  vi.unstubAllGlobals()
})

// An older host's output stream is observation only; its multiplexer is not this contract.
vi.mock('@/runtime/runtime-terminal-stream', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  subscribeToRuntimeTerminalData: async () => () => {}
}))
const capable = [
  GENERATED_INPUT_RUNTIME_CAPABILITY,
  GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY,
  GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY
]
const statusCalls = () => hostCall.mock.calls.filter(([args]) => args.method === 'status.get')

// CNG1: a selection that succeeded is this request's proof of the host's support all the way to
// its frames. Dropping the reusable cache slot meanwhile never makes it ask for status again.
it('sends on its own selected status after the cache slot is dropped, asking nothing more', async () => {
  const first = Promise.withResolvers<unknown>()
  hostCall.mockImplementation(({ method }: { method: string }) =>
    method === 'status.get'
      ? statusCalls().length === 1
        ? first.promise
        : new Promise(() => {})
      : Promise.resolve(answer({ delivery: { outcome: 'delivered' } }))
  )
  const ordinary = getRuntimeEnvironmentCapabilityStatus('env')
  const sending = sendGeneratedTerminalInputToHandle(
    { kind: 'environment', environmentId: 'env' },
    'terminal',
    { text: 'exact\r\nprompt 😀', submit: true, retainNotice: true, operationId: 'op-dropped-ok' }
  )
  clearRuntimeCompatibilityCache('env')
  first.resolve({ ...answer(status('h1', capable)), selectedPairing: { revision: 1 } })
  await ordinary
  await expect(sending).resolves.toBe('delivered')
  expect(hostCall.mock.calls.map(([args]) => args.method)).toEqual(['status.get', SEND])
})

// CNG1 on an older host, and notes' fallback to it: the one selection and end carry from the
// hosted attempt to every legacy frame and host read, so a dropped slot asks for no second status.
it('carries one selection into an older host’s frames and reads, notes included', async () => {
  const first = Promise.withResolvers<unknown>()
  const writes: string[] = []
  hostCall.mockImplementation(async (args: { method: string; params?: { text?: string } }) => {
    if (args.method === 'status.get') {
      return statusCalls().length === 1 ? first.promise : new Promise(() => {})
    }
    if (args.method === 'terminal.inspectProcess') {
      return answer({ process: { foregroundProcess: null, verdict: 'unverifiable' } })
    }
    if (args.method === 'terminal.read') {
      return answer({ terminal: { tail: [], source: 'stream' } })
    }
    writes.push(args.params?.text ?? '')
    return answer({ send: { accepted: true, bytesWritten: args.params?.text?.length ?? 0 } })
  })
  hostSubscribe.mockResolvedValue({ unsubscribe: vi.fn(), sendBinary: vi.fn() })
  const ordinary = getRuntimeEnvironmentCapabilityStatus('env')
  const notes = sendPromptWithLegacyCombinedSend(
    { kind: 'environment', environmentId: 'env' },
    'terminal',
    'exact notes'
  )
  clearRuntimeCompatibilityCache('env')
  // An older host: no generated operation, so its frames take the client's legacy route.
  first.resolve({ ...answer(status('h1', [])), selectedPairing: { revision: 1 } })
  await ordinary
  await notes
  expect(statusCalls()).toHaveLength(1)
  expect(writes.join('')).toContain('exact notes')
  for (const [args] of hostCall.mock.calls.filter(([call]) => call.method === 'terminal.send')) {
    expect(args).toMatchObject({ expectedEnvironmentPairingRevision: 1 })
    expect(args.generatedInputEnd).toEqual(expect.any(Number))
    expect(args.params).not.toHaveProperty('generatedInputEnd')
  }
})

// CNG2: the caller's budget is spent while its status is selected. Nothing reaches the host; a
// shorter selection leaves the host only the rest of that budget, never a fresh one.
it.each([
  ['spent', 2000],
  ['partly spent', 300]
] as const)(
  'gives the host only what selection left of the budget (%s)',
  async (_name, spentMs) => {
    const held = Promise.withResolvers<unknown>()
    const began = Date.now()
    let now = began
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    hostCall.mockImplementation(async ({ method }: { method: string }) =>
      method === 'status.get' ? held.promise : answer({ delivery: { outcome: 'staged' } })
    )
    try {
      const sending = sendGeneratedTerminalInputToHandle(
        { kind: 'environment', environmentId: 'env' },
        'terminal',
        {
          text: 'exact overdue draft',
          submit: false,
          agent: 'claude',
          intent: 'running',
          timeoutMs: 1000,
          retainNotice: true,
          operationId: 'op-budget'
        }
      )
      now = began + spentMs
      held.resolve({ ...answer(status('h1', capable)), selectedPairing: { revision: 1 } })
      const outcome = await sending
      const sent = hostCall.mock.calls.filter(([args]) => args.method === SEND)
      if (spentMs >= 1000) {
        expect(outcome).toBe('not-sent')
        expect(sent).toEqual([])
      } else {
        expect(outcome).toBe('staged')
        // The host's budget and main's dispatch end are what remains of the one end.
        expect(sent[0][0].params.timeoutMs).toBe(1000 - spentMs)
        expect(sent[0][0].generatedInputEnd).toBe(began + 1000)
      }
    } finally {
      clock.mockRestore()
    }
  }
)

// CNG3: the shared operation's end reaches its legacy writer. Cancelled or expired while the
// writer still waits for the host's status, it ends and sends nothing afterwards; a frame genuinely
// handed over whose answer is lost stays possibly sent.
it.each(['cancelled', 'expired', 'issued then lost'] as const)(
  'ends a legacy write with its operation (%s)',
  async (ending) => {
    const { createLegacyGeneratedInputSource } = await import('./agent-draft-readiness')
    const { runGeneratedInputOperation } = await import('../../../shared/generated-input-operation')
    const { GeneratedInputLifetime } = await import('../../../shared/generated-input-lifetime')
    const source = createLegacyGeneratedInputSource({
      ptyId: toRemoteRuntimePtyId('terminal', 'env'),
      content: 'exact stopped draft',
      agent: 'claude',
      inputKind: 'driving',
      operationId: 'op-legacy-stop'
    })
    // Facts only, an older host's blind route; its gate, queue, writer and RPC are real.
    source.read = async () => ({
      screen: 'unknown',
      process: { known: false },
      bracketedPaste: null
    })
    source.observe = () => () => {}
    source.replay = () => ''
    const held = Promise.withResolvers<unknown>()
    const lost = Promise.withResolvers<unknown>()
    hostCall.mockImplementation(async ({ method }: { method: string }) =>
      method === 'status.get' ? held.promise : lost.promise
    )
    const cancel = new AbortController()
    const lifetime = new GeneratedInputLifetime({
      deadline: Date.now() + (ending === 'expired' ? 400 : 5000),
      signal: cancel.signal,
      submit: false
    })
    const sending = runGeneratedInputOperation(source, {
      agent: 'claude',
      submit: false,
      intent: 'running',
      lifetime
    })
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(1))
    if (ending === 'issued then lost') {
      held.resolve({ ...answer(status('h1', [])), selectedPairing: { revision: 1 } })
      await vi.waitFor(() => expect(hostCall).toHaveBeenCalledTimes(2))
      lost.reject(new Error('socket closed'))
      const result = await sending
      await result.finished
      expect(result.outcome).toBe('unconfirmed')
      return
    }
    if (ending === 'cancelled') {
      cancel.abort()
    }
    const result = await sending
    await result.finished
    held.resolve({ ...answer(status('h1', [])), selectedPairing: { revision: 1 } })
    // ast-grep-ignore: test-no-real-time-wait -- an absent write after the end has no event to await
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(result.outcome).toBe('not-sent')
    expect(hostCall.mock.calls.map(([args]) => args.method)).toEqual(['status.get'])
  }
)

// CV1: an older host's evidence reads go to the pairing this request was selected on, like its
// writes. Re-paired since, either read is refused there and the request ends at once, unsent; no
// other pairing's screen (here a dialog) holds it. On the same pairing, its blind route delivers.
it.each(['terminal.inspectProcess', 'terminal.read', 'same pairing'] as const)(
  'reads an older host’s evidence only on the selected pairing (%s refused)',
  async (refused) => {
    const { generatedInputAttempt } = await import('@/runtime/generated-input-attempt')
    const { replaceRuntimeEnvironmentRevisions } =
      await import('@/runtime/runtime-environment-revision')
    const { createLegacyGeneratedInputSource } = await import('./agent-draft-readiness')
    const { runGeneratedInputOperation } = await import('../../../shared/generated-input-operation')
    const { GeneratedInputLifetime } = await import('../../../shared/generated-input-lifetime')
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 1 }])
    hostCall.mockImplementation(async ({ method }: { method: string }) =>
      method === 'status.get'
        ? { ...answer(status('h1', [])), selectedPairing: { revision: 1 } }
        : answer({})
    )
    const attempt = generatedInputAttempt(Date.now() + 10_000)
    const target = { kind: 'environment' as const, environmentId: 'env' }
    await expect(
      sendGeneratedTerminalInputToHandle(
        target,
        'terminal',
        { text: 'exact accepted draft', submit: false },
        undefined,
        undefined,
        undefined,
        attempt
      )
    ).resolves.toBeNull()
    expect(attempt.selection?.pairingRevision).toBe(1)
    const repaired = refused !== 'same pairing'
    if (repaired) {
      replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 2 }], {
        retired: ['env'],
        sameHost: []
      })
    }
    const dialog = ['Bypass Permissions', '❯ 1. No, exit', '  2. Yes, I accept', 'Enter to confirm']
    hostCall.mockImplementation(
      async (args: { method: string; expectedEnvironmentPairingRevision?: number }) => {
        if (args.expectedEnvironmentPairingRevision === 1 && args.method === refused) {
          return {
            id: 'x',
            ok: false,
            error: { code: 'runtime_environment_changed', message: 'Pairing changed' },
            _meta: { runtimeId: 'h2' }
          }
        }
        if (args.method === 'terminal.inspectProcess') {
          return args.expectedEnvironmentPairingRevision === 1
            ? answer({ process: { foregroundProcess: null, verdict: 'unverifiable' } })
            : answer({ process: { foregroundProcess: 'claude', verdict: 'verified' } }, 'h2')
        }
        if (args.method === 'terminal.read') {
          return args.expectedEnvironmentPairingRevision === 1
            ? answer({ terminal: { tail: [], source: 'stream' } })
            : answer({ terminal: { tail: dialog, source: 'screen' } }, 'h2')
        }
        return answer({ send: { accepted: true } })
      }
    )
    const source = createLegacyGeneratedInputSource({
      ptyId: toRemoteRuntimePtyId('terminal', 'env'),
      content: 'exact accepted draft',
      agent: 'claude',
      inputKind: 'driving',
      attempt
    })
    const lifetime = new GeneratedInputLifetime({
      deadline: attempt.end,
      submit: false
    })
    try {
      const result = await runGeneratedInputOperation(source, {
        agent: 'claude',
        submit: false,
        intent: 'running',
        lifetime
      })
      await result.finished
      const reads = hostCall.mock.calls
        .map(([args]) => args)
        .filter(({ method }) => method === 'terminal.inspectProcess' || method === 'terminal.read')
      const sends = hostCall.mock.calls.filter(([args]) => args.method === 'terminal.send')
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((args) => args.expectedEnvironmentPairingRevision === 1)).toBe(true)
      if (repaired) {
        expect(result.outcome).toBe('not-sent')
        expect(sends).toEqual([])
        // Ended by the refusal, long before the request's own end.
        expect(Date.now()).toBeLessThan(attempt.end! - 5_000)
      } else {
        expect(result.outcome).toBe('staged')
        expect(sends.map(([args]) => args.expectedEnvironmentPairingRevision)).toEqual([1])
      }
    } finally {
      lifetime.retire()
      replaceRuntimeEnvironmentRevisions([])
    }
  }
)
