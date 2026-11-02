import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  type ReleaseCheckout
} from './release-checkout'

// Keep cross-build structural views minimal so legitimate internal differences cannot bind the harness to one version.

export type TerminalStreamFrame = {
  opcode: number
  streamId: number
  seq: number
  payload: Uint8Array
}

export type WireCodec = {
  TerminalStreamOpcode: Record<string, number | string>
  encodeTerminalStreamFrame: (frame: TerminalStreamFrame) => Uint8Array
  decodeTerminalStreamFrame: (bytes: Uint8Array) => TerminalStreamFrame | null
  encodeTerminalStreamJson: (value: unknown) => Uint8Array
  decodeTerminalStreamJson: <T>(payload: Uint8Array) => T | null
  encodeTerminalStreamText: (value: string) => Uint8Array
  decodeTerminalStreamText: (payload: Uint8Array) => string
}

export type HostRpcContext = {
  connectionId: string
  sendBinary: (bytes: Uint8Array) => boolean | void
  registerBinaryStreamHandler: (
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ) => () => void
  signal?: AbortSignal
}

export type HostWire = {
  RpcDispatcher: new (options: { runtime: unknown; methods: unknown[] }) => {
    dispatchStreaming: (
      request: { id: string; authToken: string; method: string; params?: unknown },
      onMessage: (message: string) => void,
      context: HostRpcContext
    ) => Promise<unknown>
  }
  TERMINAL_METHODS: unknown[]
}

export type ClientTerminalCallbacks = {
  onData: (data: string, meta?: { seq?: number; rawLength?: number }) => void
  onSnapshot: (data: string, meta?: { pendingEscapeTailAnsi?: string }) => void
  onSubscribed?: () => void
  onOutputPauseCapability?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
  onTransportClose?: (event: { recoverable: boolean; retryWithBackoff?: boolean }) => void
}

export type ClientTerminal = {
  streamId: number
  sendInput: (text: string) => boolean
  resize: (cols: number, rows: number) => boolean
  setOutputPaused: (paused: boolean) => boolean
  serializeBuffer: (opts?: { scrollbackRows?: number }) => Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    source?: string
  } | null>
  close: () => void
}

export type ClientWire = {
  getRemoteRuntimeTerminalMultiplexer: (runtimeId: string) => {
    subscribeTerminal: (args: {
      terminal: string
      client: { id: string; type: 'desktop' | 'mobile' }
      viewport?: { cols: number; rows: number }
      callbacks: ClientTerminalCallbacks
    }) => Promise<ClientTerminal>
  }
  resetRemoteRuntimeTerminalMultiplexersForTests: () => void
}

export type TerminalWireBuild = {
  /** Human label used in test names and failure messages. */
  label: string
  /** `working-tree` for current code, otherwise the resolved release commit. */
  revision: string
  codec: WireCodec
  host: HostWire
  client: ClientWire
}

export const WORKING_TREE = 'working-tree' as const

async function loadWorkingTreeBuild(): Promise<TerminalWireBuild> {
  const [codec, dispatcher, terminalMethods, client] = await Promise.all([
    import('../../../src/shared/terminal-stream-protocol'),
    import('../../../src/main/runtime/rpc/dispatcher'),
    import('../../../src/main/runtime/rpc/methods/terminal'),
    import('../../../src/renderer/src/runtime/remote-runtime-terminal-multiplexer')
  ])
  return {
    label: WORKING_TREE,
    revision: WORKING_TREE,
    codec: codec as unknown as WireCodec,
    host: {
      RpcDispatcher: dispatcher.RpcDispatcher as unknown as HostWire['RpcDispatcher'],
      TERMINAL_METHODS: terminalMethods.TERMINAL_METHODS as unknown[]
    },
    client: client as unknown as ClientWire
  }
}

async function loadReleaseBuild(checkout: ReleaseCheckout): Promise<TerminalWireBuild> {
  const [codec, dispatcher, terminalMethods, client] = await Promise.all([
    importReleaseCheckoutModule(checkout, '/src/shared/terminal-stream-protocol.ts'),
    importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/dispatcher.ts'),
    importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/methods/terminal.ts'),
    importReleaseCheckoutModule(
      checkout,
      '/src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts'
    )
  ])
  return {
    label: checkout.ref,
    revision: checkout.commit,
    codec: codec as WireCodec,
    host: {
      RpcDispatcher: dispatcher.RpcDispatcher as HostWire['RpcDispatcher'],
      TERMINAL_METHODS: terminalMethods.TERMINAL_METHODS as unknown[]
    },
    client: client as ClientWire
  }
}

// Import current source for WORKING_TREE so injected violations execute; extract other refs into the cache.
export async function loadTerminalWireBuild(ref: string): Promise<TerminalWireBuild> {
  if (ref === WORKING_TREE) {
    return loadWorkingTreeBuild()
  }
  return loadReleaseBuild(await materializeReleaseCheckout(ref))
}

// Remove decoder support to model an older peer’s silent frame drops without requiring a pre-opcode release.
export function withoutOpcodeSupport(
  build: TerminalWireBuild,
  opcodeName: string
): TerminalWireBuild {
  const opcode = build.codec.TerminalStreamOpcode[opcodeName]
  if (typeof opcode !== 'number') {
    throw new Error(`Build ${build.label} publishes no terminal stream opcode named ${opcodeName}`)
  }
  return {
    ...build,
    label: `${build.label}-without-${opcodeName}`,
    codec: {
      ...build.codec,
      // Remove both mapping directions so observers cannot retain a name the decoder no longer knows.
      TerminalStreamOpcode: Object.fromEntries(
        Object.entries(build.codec.TerminalStreamOpcode).filter(
          ([name, value]) => name !== opcodeName && value !== opcodeName
        )
      ),
      decodeTerminalStreamFrame: (bytes) => {
        const frame = build.codec.decodeTerminalStreamFrame(bytes)
        return frame && frame.opcode === opcode ? null : frame
      }
    }
  }
}
