import { expect, vi } from 'vitest'
import {
  importBuildModule,
  type TerminalWireBuild,
  type WireCodec
} from './versioned-terminal-wire'

/**
 * The second half of the cross-version contract: not "does the frame decode", but
 * "what does the receiving build DO with what the other build publishes".
 *
 * A reattach whose output source must be re-established is the case this program
 * changed. The host publishes a failure token for it, and the client turns that
 * token into either nothing or `terminal.recoverPane` — a host-side mutation that
 * replaces the pane's shell. Because the token is a plain string on an existing
 * error channel, no opcode changes and no decoder rejects anything; the only way
 * to see the skew is to run a real host build's publication into a real client
 * build's decision.
 */

const CONNECTION_ID = 'conn-1'
const SESSION_ID = 'pty-old'
const RUNTIME_ENVIRONMENT_ID = 'env-1'
const PANE_TAB_ID = 'tab-1'
const PANE_LEAF_ID = 'pane:1'
const PANE_WORKTREE_ID = 'wt-1'
const PANE_HANDLE = 'terminal-1'
const PANE_PTY_ID = `remote:${RUNTIME_ENVIRONMENT_ID}@@${PANE_HANDLE}`
const REPLACEMENT_HANDLE = 'terminal-2'
const DRIVE_TIMEOUT_MS = 10_000

type SshProviderModule = {
  SshPtyProvider: new (
    connectionId: string,
    mux: unknown
  ) => { spawn: (options: unknown) => Promise<unknown> }
}

/**
 * Drive a build's REAL `SshPtyProvider` through a reattach the relay answers with
 * `sourceRecovery.restoreRequired`, and return the message that build publishes.
 * Nothing here hardcodes a token, so the oracle moves when production moves.
 */
export async function capturePublishedRestoreRequiredFailure(
  build: TerminalWireBuild
): Promise<string> {
  const module = (await importBuildModule(
    build.label,
    'main/providers/ssh-pty-provider.ts'
  )) as unknown as SshProviderModule
  const mux = {
    request: vi.fn().mockResolvedValue({
      incarnationId: 'incarnation-reattached',
      sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
    }),
    notify: vi.fn(),
    onNotification: vi.fn().mockReturnValue(vi.fn())
  }
  const provider = new module.SshPtyProvider(CONNECTION_ID, mux)
  try {
    await provider.spawn({ cols: 80, rows: 24, sessionId: SESSION_ID })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(
    `${build.label}: reattach with sourceRecovery=restoreRequired resolved instead of failing closed`
  )
}

export type ClientReattachFailureOutcome = {
  clientLabel: string
  /** Runtime RPC methods the client called after the failure, in order. */
  methodsAfterFailure: string[]
  /** `terminal.recoverPane` params — a host mutation that replaces the pane's shell. */
  paneReplacementRequests: Record<string, unknown>[]
  /** Messages the client put on the pane's red error surface. */
  surfacedErrors: string[]
  /** Handles the client subscribed to, including any replacement it adopted. */
  subscribedHandles: string[]
  /** The client reached a genuinely connected pane before the fault was injected. */
  connectedBeforeFault: boolean
}

type TransportModule = {
  createRemoteRuntimePtyTransport: (
    environmentId: string,
    options: Record<string, unknown>
  ) => {
    attach: (options: Record<string, unknown>) => void
    isConnected: () => boolean
    destroy?: () => void
  }
}

function paneResult(handle: string, paneKey: string, worktreeId: string): unknown {
  const separator = paneKey.indexOf(':')
  return {
    ok: true,
    result: {
      terminal: {
        handle,
        tabId: paneKey.slice(0, separator),
        leafId: paneKey.slice(separator + 1),
        worktreeId
      }
    }
  }
}

function emitSnapshot(
  codec: WireCodec,
  send: (bytes: Uint8Array) => void,
  streamId: number,
  data: string
): void {
  const opcodes = codec.TerminalStreamOpcode
  send(
    codec.encodeTerminalStreamFrame({
      opcode: Number(opcodes.SnapshotStart),
      streamId,
      seq: 1,
      payload: codec.encodeTerminalStreamJson({ kind: 'scrollback' })
    })
  )
  send(
    codec.encodeTerminalStreamFrame({
      opcode: Number(opcodes.SnapshotChunk),
      streamId,
      seq: 2,
      payload: codec.encodeTerminalStreamText(data)
    })
  )
  send(
    codec.encodeTerminalStreamFrame({
      opcode: Number(opcodes.SnapshotEnd),
      streamId,
      seq: 3,
      payload: new Uint8Array()
    })
  )
}

async function settle(label: string, predicate: () => boolean): Promise<void> {
  try {
    await vi.waitFor(() => expect(predicate()).toBe(true), {
      timeout: DRIVE_TIMEOUT_MS,
      interval: 5
    })
  } catch {
    throw new Error(`Reattach-failure skew drive stalled at: ${label}`)
  }
}

/**
 * Attach one client build to a live remote pane, then fail its post-outage
 * resubscribe with `publishedFailure` — the exact string a host build published.
 * The fault lands on `terminal.resolvePane` over the same Electron IPC boundary
 * the transport really uses, so every lifecycle route stays reachable.
 */
export async function driveClientReattachFailure(args: {
  clientBuild: TerminalWireBuild
  publishedFailure: string
}): Promise<ClientReattachFailureOutcome> {
  const { clientBuild, publishedFailure } = args
  const codec = clientBuild.codec
  const methodLog: string[] = []
  const paneReplacementRequests: Record<string, unknown>[] = []
  const surfacedErrors: string[] = []
  const sentFrames: Uint8Array[] = []
  let resolvePaneFailure: Error | null = null
  let streamCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array) => void
    onClose?: () => void
  } | null = null

  const call = vi.fn(async (request: { method: string; params?: unknown }) => {
    methodLog.push(request.method)
    const params = (request.params ?? {}) as { paneKey?: string; worktreeId?: string }
    if (request.method === 'terminal.resolvePane') {
      const failure = resolvePaneFailure
      if (failure) {
        resolvePaneFailure = null
        throw failure
      }
      return paneResult(PANE_HANDLE, params.paneKey ?? '', params.worktreeId ?? '')
    }
    if (request.method === 'terminal.recoverPane') {
      paneReplacementRequests.push(request.params as Record<string, unknown>)
      return paneResult(REPLACEMENT_HANDLE, params.paneKey ?? '', params.worktreeId ?? '')
    }
    return { ok: true, result: { terminal: { handle: PANE_HANDLE } } }
  })

  const subscribe = vi.fn(async (_args: unknown, callbacks: typeof streamCallbacks) => {
    streamCallbacks = callbacks
    queueMicrotask(() => callbacks?.onResponse({ ok: true, result: { type: 'ready' } }))
    return {
      unsubscribe: vi.fn(),
      sendBinary: (bytes: Uint8Array) => {
        sentFrames.push(bytes)
      }
    }
  })

  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call, subscribe } },
    location: { search: '' }
  })

  const subscribePayloads = (): { streamId: number; terminal: string }[] =>
    sentFrames.flatMap((bytes) => {
      const frame = codec.decodeTerminalStreamFrame(bytes)
      if (!frame || frame.opcode !== Number(codec.TerminalStreamOpcode.Subscribe)) {
        return []
      }
      const payload = codec.decodeTerminalStreamJson<{ streamId: number; terminal: string }>(
        frame.payload
      )
      return payload ? [payload] : []
    })

  const module = (await importBuildModule(
    clientBuild.label,
    'renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts'
  )) as unknown as TransportModule

  const transport = module.createRemoteRuntimePtyTransport(RUNTIME_ENVIRONMENT_ID, {
    worktreeId: PANE_WORKTREE_ID,
    tabId: PANE_TAB_ID,
    leafId: PANE_LEAF_ID
  })
  try {
    transport.attach({
      existingPtyId: PANE_PTY_ID,
      cols: 80,
      rows: 24,
      callbacks: {
        onError: (message: string) => {
          surfacedErrors.push(message)
        }
      }
    })
    await settle('client never sent a subscribe frame', () => subscribePayloads().length >= 1)
    const first = subscribePayloads().at(-1)
    emitSnapshot(
      codec,
      (bytes) => streamCallbacks?.onBinary?.(bytes),
      first?.streamId ?? 0,
      'live before the fault'
    )
    const connectedBeforeFault = transport.isConnected()

    // Only now does the pane become skew-relevant: the stream drops, and the
    // host answers the resubscribe with the token its build publishes.
    const methodsBeforeFault = methodLog.length
    resolvePaneFailure = new Error(publishedFailure)
    streamCallbacks?.onClose?.()
    await settle(
      'client never reacted to the failed resubscribe',
      () =>
        methodLog.length > methodsBeforeFault &&
        (paneReplacementRequests.length > 0 ||
          surfacedErrors.length > 0 ||
          subscribePayloads().length > 1)
    )

    return {
      clientLabel: clientBuild.label,
      methodsAfterFailure: methodLog.slice(methodsBeforeFault),
      paneReplacementRequests,
      surfacedErrors,
      subscribedHandles: subscribePayloads().map((payload) => payload.terminal),
      connectedBeforeFault
    }
  } finally {
    transport.destroy?.()
    vi.unstubAllGlobals()
  }
}

export const SKEW_PANE = {
  handle: PANE_HANDLE,
  replacementHandle: REPLACEMENT_HANDLE,
  ptyId: PANE_PTY_ID,
  paneKey: `${PANE_TAB_ID}:${PANE_LEAF_ID}`,
  worktreeId: PANE_WORKTREE_ID,
  sessionId: SESSION_ID,
  connectionId: CONNECTION_ID
}
