import { beforeEach, vi } from 'vitest'
import type {
  RemoteRuntimeMultiplexedTerminal,
  RemoteRuntimeMultiplexedTerminalCallbacks
} from '../../runtime/hosted-terminals/streams/remote-terminal-stream-contracts'
import { createTauriPtyApi as createApi } from './web-tauri-pty-api'
import type { TauriPtySpawnOptions } from './web-tauri-pty-runtime-params'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'

export { callRuntimeResult, callTauriPtyHost, requireActiveEnvironment, subscribeTerminal }

export function createTauriPtyApi() {
  return createApi()
}

const { callRuntimeResult, callTauriPtyHost, requireActiveEnvironment, subscribeTerminal } =
  vi.hoisted(() => ({
    callRuntimeResult: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
    callTauriPtyHost: vi.fn(
      async (_id: string, _method: string, _params: unknown): Promise<unknown> => undefined
    ),
    requireActiveEnvironment: vi.fn(() => ({ id: 'env-1' })),
    subscribeTerminal:
      vi.fn<
        (args: {
          callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
          inputSessionId?: string
        }) => Promise<RemoteRuntimeMultiplexedTerminal>
      >()
  }))

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))
vi.mock('./web-tauri-pty-host', () => ({ callTauriPtyHost }))
vi.mock('./web-runtime-session', () => ({ requireActiveEnvironment }))
vi.mock(
  '../../runtime/hosted-terminals/streams/registry/remote-runtime-terminal-multiplexer-registry',
  () => ({
    getRemoteRuntimeTerminalMultiplexer: () => ({ subscribeTerminal })
  })
)

type MutableStream = RemoteRuntimeMultiplexedTerminal & {
  sent: { text: string; seq?: number }[]
}

export let stream: MutableStream
export let callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
let terminalNumber = 0
const spawnedIds = new Set<string>()

export function createStream(acknowledgesInput: boolean): MutableStream {
  const sent: MutableStream['sent'] = []
  return {
    streamId: 1,
    sent,
    setOutputCadence: vi.fn(),
    sendInput: vi.fn((text: string, inputSeq?: number) => {
      sent.push({ text, seq: inputSeq })
      return true
    }),
    acknowledgesInput: vi.fn(() => acknowledgesInput),
    inputLedgerId: vi.fn(() => 'ledger-1'),
    resize: vi.fn(() => true),
    claimViewport: vi.fn(() => true),
    setOutputPaused: vi.fn(() => true),
    serializeBuffer: vi.fn(async () => null),
    serializeBufferOutcome: vi.fn(async () => ({
      availability: { kind: 'retry-worthy', cause: 'stream-detached' } as const,
      snapshot: null
    })),
    close: vi.fn()
  }
}

export async function spawn(
  acknowledgesInput: boolean,
  options: Partial<TauriPtySpawnOptions> = {},
  handle?: string,
  terminalOverrides: Partial<RuntimeTerminalCreate> = {}
) {
  terminalNumber += 1
  const resolvedHandle = handle ?? `terminal-${terminalNumber}`
  stream = createStream(acknowledgesInput)
  subscribeTerminal.mockImplementationOnce(
    async (args: { callbacks: RemoteRuntimeMultiplexedTerminalCallbacks }) => {
      callbacks = args.callbacks
      // The real multiplexer delivers the initial image before subscribeTerminal resolves.
      args.callbacks.onSnapshot?.('', { cols: 80, rows: 24, seq: 0 })
      return stream
    }
  )
  callRuntimeResult.mockResolvedValueOnce({
    terminal: {
      handle: resolvedHandle,
      ptyId: `pty-${resolvedHandle}`,
      worktreeId: 'C:/repo',
      incarnationId: `incarnation-${resolvedHandle}`,
      ...terminalOverrides
    }
  })
  const result = await createTauriPtyApi().spawn({ cols: 80, rows: 24, ...options })
  spawnedIds.add(result.id)
  return result
}

beforeEach(async () => {
  callTauriPtyHost.mockReset()
  for (const id of spawnedIds) {
    await createTauriPtyApi().kill(id)
  }
  spawnedIds.clear()
  callRuntimeResult.mockReset()
  callTauriPtyHost.mockReset()
  subscribeTerminal.mockReset()
  requireActiveEnvironment.mockReturnValue({ id: 'env-1' })
  terminalNumber = 0
})
