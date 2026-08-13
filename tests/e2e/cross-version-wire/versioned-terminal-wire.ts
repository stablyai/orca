import { materializeReleaseCheckout, REPO_ROOT, type ReleaseCheckout } from './release-checkout'

/**
 * Structural views of the three modules that make up the remote terminal wire.
 * Kept minimal on purpose: the harness pairs two builds of these modules, so it
 * must not depend on internals that legitimately differ between versions.
 */

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

// Why @vite-ignore: the checkout is created at run time, so Vite cannot glob it at
// transform time. Vite-node still resolves and transforms the target on demand.
function importFromCheckout(specifier: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>
}

async function loadReleaseBuild(checkout: ReleaseCheckout): Promise<TerminalWireBuild> {
  const base = `${checkout.root}/src`
  const [codec, dispatcher, terminalMethods, client] = await Promise.all([
    importFromCheckout(`${base}/shared/terminal-stream-protocol.ts`),
    importFromCheckout(`${base}/main/runtime/rpc/dispatcher.ts`),
    importFromCheckout(`${base}/main/runtime/rpc/methods/terminal.ts`),
    importFromCheckout(`${base}/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts`)
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

/**
 * Import one `src/…`-relative module from a build. Lets a skew case reach code the
 * fixed {@link TerminalWireBuild} surface does not name — e.g. the SSH provider that
 * publishes a failure token, or the client that decides what to do with it.
 */
export async function importBuildModule(
  ref: string,
  pathUnderSrc: string
): Promise<Record<string, unknown>> {
  if (ref === WORKING_TREE) {
    return await importFromCheckout(`${REPO_ROOT}/src/${pathUnderSrc}`)
  }
  const checkout = materializeReleaseCheckout(ref)
  return await importFromCheckout(`${checkout.root}/src/${pathUnderSrc}`)
}

/**
 * Load the wire modules for one build. `WORKING_TREE` imports current source (so a
 * locally injected violation is exercised); any other value is a git ref extracted
 * into a cached checkout.
 */
export async function loadTerminalWireBuild(ref: string): Promise<TerminalWireBuild> {
  if (ref === WORKING_TREE) {
    return loadWorkingTreeBuild()
  }
  return loadReleaseBuild(materializeReleaseCheckout(ref))
}
