import type { PreloadApi } from '../../../../preload/api-types'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'
import { requireActiveEnvironment } from '../runtime/client/web-runtime-session'
import { getRemoteRuntimeTerminalMultiplexer } from '../../runtime/hosted-terminals/streams/registry/remote-runtime-terminal-multiplexer-registry'
import type { RemoteRuntimeMultiplexedTerminal } from '../../runtime/hosted-terminals/streams/remote-terminal-stream-contracts'
import {
  emitTauriPtyData,
  emitTauriPtyExit,
  emitTauriPtyReplay,
  emitTauriPtySpawned
} from './web-tauri-pty-event-channel'
import { createTauriPtyInputSession, tauriPtyInputSessionKey } from './web-tauri-pty-input-session'
import type { TauriPtyInputSession } from './web-tauri-pty-input-session'
import {
  tauriPtyRuntimeCreateParams,
  type TauriPtySpawnOptions
} from './web-tauri-pty-runtime-params'
import type { TauriPtyState } from './web-tauri-pty-state'
import { callTauriPtyHost } from './web-tauri-pty-host'
import { createTauriPtySnapshotHandshake } from './web-tauri-pty-snapshot-handshake'

type SpawnResult = Awaited<ReturnType<NonNullable<PreloadApi['pty']>['spawn']>>

const tauriPtyStates = new Map<string, TauriPtyState>()
const tauriPtyInputSessions = new Map<string, TauriPtyInputSession>()

function retireTauriPty(
  id: string,
  inputSession: TauriPtyInputSession,
  stream: RemoteRuntimeMultiplexedTerminal | null,
  code: number,
  discardInput: boolean,
  preserveRendererBinding = false
): void {
  if (!stream || tauriPtyStates.get(id)?.stream !== stream) {
    return
  }
  tauriPtyStates.delete(id)
  inputSession.current = null
  if (discardInput) {
    inputSession.journal.discard()
    tauriPtyInputSessions.delete(inputSession.key)
  }
  emitTauriPtyExit(id, code, preserveRendererBinding)
}

/** Drop the renderer binding after the host stopped the PTY; the host already closed the pane. */
export function dropTauriPtyState(state: TauriPtyState): void {
  tauriPtyStates.delete(state.id)
  state.inputSession.current = null
  state.inputSession.journal.discard()
  tauriPtyInputSessions.delete(state.inputSession.key)
  state.stream.close()
}

export async function spawnTauriPty(opts: TauriPtySpawnOptions): Promise<SpawnResult> {
  const environment = requireActiveEnvironment()
  const result = await callRuntimeResult<{ terminal: RuntimeTerminalCreate }>(
    'terminal.create',
    tauriPtyRuntimeCreateParams(opts)
  )
  const terminal = result.terminal
  const id = toRemoteRuntimePtyId(terminal.handle, environment.id)
  const key = tauriPtyInputSessionKey(environment.id, opts, terminal)
  const inputSession = tauriPtyInputSessions.get(key) ?? createTauriPtyInputSession(key)
  tauriPtyInputSessions.set(key, inputSession)
  let subscribedStream: RemoteRuntimeMultiplexedTerminal | null = null
  const isCurrentStream = (): boolean =>
    subscribedStream === null || tauriPtyStates.get(id)?.stream === subscribedStream
  const snapshotHandshake = createTauriPtySnapshotHandshake()
  const stream = await getRemoteRuntimeTerminalMultiplexer(environment.id)
    .subscribeTerminal({
      terminal: terminal.handle,
      client: { id: `tauri-pty:${id}`, type: 'desktop' },
      viewport: { cols: opts.cols, rows: opts.rows },
      inputSessionId: inputSession.journal.sessionId,
      callbacks: {
        onSnapshot: (data, meta) => {
          if (!snapshotHandshake.accept(data, meta) && isCurrentStream()) {
            emitTauriPtyReplay(id, data)
          }
        },
        onData: (data, meta) =>
          isCurrentStream() &&
          emitTauriPtyData({
            id,
            data,
            ...meta,
            rawLength: meta?.rawLength ?? data.length
          }),
        onEnd: (verdict) => {
          snapshotHandshake.fail(new Error(`terminal_initial_snapshot_${verdict}`))
          const exited = verdict === 'exited'
          const code = exited ? 0 : 1
          retireTauriPty(id, inputSession, subscribedStream, code, exited, !exited)
        },
        onError: () => {
          snapshotHandshake.fail(new Error('terminal_initial_snapshot_unavailable'))
          retireTauriPty(id, inputSession, subscribedStream, 1, false, true)
        },
        onTransportClose: () => {
          snapshotHandshake.fail(new Error('terminal_initial_snapshot_disconnected'))
          retireTauriPty(id, inputSession, subscribedStream, 1, false, true)
        },
        onInputAck: (appliedSeq, kind) => {
          if (subscribedStream && inputSession.current?.stream === subscribedStream) {
            inputSession.journal.acknowledge(appliedSeq, kind)
          }
        },
        onSubscribeAcknowledged: () => {
          if (
            inputSession.current?.stream === subscribedStream &&
            subscribedStream?.acknowledgesInput()
          ) {
            inputSession.journal.resume(subscribedStream, inputSession.current.endpoint)
          }
        }
      }
    })
    .catch((error: unknown) => {
      snapshotHandshake.fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    })
  subscribedStream = stream
  let initialSnapshot
  try {
    initialSnapshot = await snapshotHandshake.wait()
  } catch (error) {
    stream.close()
    throw error
  }
  const state: TauriPtyState = {
    id,
    handle: terminal.handle,
    ptyId: terminal.ptyId ?? undefined,
    worktreeId: terminal.worktreeId,
    cwd: opts.cwd ?? '',
    size: { cols: opts.cols, rows: opts.rows },
    stream,
    endpoint: { handle: terminal.handle, incarnationId: terminal.incarnationId ?? null },
    inputSession
  }
  inputSession.current = { stream, endpoint: state.endpoint }
  const previousState = tauriPtyStates.get(id)
  tauriPtyStates.set(id, state)
  for (const [oldId, oldState] of tauriPtyStates) {
    if (oldState.inputSession === inputSession && oldId !== id) {
      tauriPtyStates.delete(oldId)
      oldState.stream.close()
    }
  }
  if (previousState && previousState !== state) {
    previousState.stream.close()
  }
  if (stream.acknowledgesInput()) {
    inputSession.journal.resume(stream, state.endpoint)
  }
  emitTauriPtySpawned(id)
  if (!terminal.isReattach && initialSnapshot.snapshot) {
    emitTauriPtyData({ id, data: initialSnapshot.snapshot, rawLength: 0, transformed: true })
  }
  return {
    id,
    incarnationId: terminal.incarnationId ?? undefined,
    isReattach: terminal.isReattach,
    ...(terminal.isReattach ? initialSnapshot : {}),
    launchConfig: opts.launchConfig,
    shellReadyArmed: undefined
  }
}

export function sendTauriPty(id: string, text: string, inputKind: TerminalInputKind): boolean {
  const state = tauriPtyStates.get(id)
  if (!state) {
    return false
  }
  if (!text) {
    return true
  }
  if (state.stream.acknowledgesInput()) {
    state.inputSession.journal.send(state.stream, state.endpoint, [
      { text, queryReply: inputKind === 'query-reply' }
    ])
    return true
  }
  return state.stream.sendInput(text)
}

export function stateFor(id: string): TauriPtyState | null {
  return tauriPtyStates.get(id) ?? null
}

export function sendTerminalCommand(id: string, method: string): void {
  const state = stateFor(id)
  if (state) {
    void callTauriPtyHost(state.id, method, { terminal: state.handle }).catch(() => {})
  }
}
