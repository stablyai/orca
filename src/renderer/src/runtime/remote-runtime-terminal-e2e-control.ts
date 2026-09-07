import { TerminalStreamOpcode } from '../../../shared/terminal-stream-protocol'
import { e2eConfig } from '@/lib/e2e-config'
import type {
  RemoteRuntimeMultiplexedTerminalState,
  RuntimeEnvironmentSubscriptionHandle
} from './remote-runtime-terminal-multiplexer-types'

type E2eRemoteTerminalMultiplexAckGateSnapshot = {
  activeStreams: { environmentId: string; streamId: number; terminal: string }[]
  droppedOutputBytes: number
  droppedOutputFrames: number
  heldTerminalCount: number
  heldStreamCount: number
  heldAckChars: number
  releasedAckChars: number
  streamSubscribeCount: number
  streamUnsubscribeCount: number
  initialSnapshotTruncatedCount: number
  transportSubscribeCount: number
  transportUnsubscribeCount: number
}

type E2eRemoteTerminalMultiplexAckGateApi = {
  dropOutputUntilResubscribe: (terminals: string[]) => number
  forceError: (terminals: string[], message: string) => number
  hold: (terminals: string[]) => void
  holdEnd: (terminals: string[]) => void
  release: () => void
  sendInput: (terminal: string, text: string) => number
  snapshot: () => E2eRemoteTerminalMultiplexAckGateSnapshot
}

type E2eRemoteTerminalMultiplexAckGateWindow = Window & {
  __remoteTerminalMultiplexAckGate?: E2eRemoteTerminalMultiplexAckGateApi
}

export type RemoteRuntimeTerminalMultiplexerE2eAccess = {
  getStreamsForE2e: () => Iterable<RemoteRuntimeMultiplexedTerminalState>
  forceErrorForE2e: (terminals: ReadonlySet<string>, message: string) => number
  releaseHeldAcksForE2e: () => number
  sendInputForE2e: (terminal: string, text: string) => number
}

const e2eHeldRemoteAckTerminals = new Set<string>()
const e2eHeldRemoteEndTerminals = new Set<string>()
const e2eDroppedOutputStreams = new Set<RemoteRuntimeMultiplexedTerminalState>()
let e2eDroppedOutputBytes = 0
let e2eDroppedOutputFrames = 0
let e2eReleasedRemoteAckChars = 0
let e2eStreamSubscribeCount = 0
let e2eStreamUnsubscribeCount = 0
let e2eInitialSnapshotTruncatedCount = 0
let e2eTransportSubscribeCount = 0
let e2eTransportUnsubscribeCount = 0

export function shouldHoldE2eRemoteTerminalAck(terminal: string): boolean {
  return e2eConfig.exposeStore && e2eHeldRemoteAckTerminals.has(terminal)
}

export function shouldHoldE2eRemoteTerminalEnd(terminal: string): boolean {
  return e2eConfig.exposeStore && e2eHeldRemoteEndTerminals.has(terminal)
}

function getE2eRemoteAckSnapshot(
  multiplexers: ReadonlyMap<string, RemoteRuntimeTerminalMultiplexerE2eAccess>
): E2eRemoteTerminalMultiplexAckGateSnapshot {
  const activeStreams: E2eRemoteTerminalMultiplexAckGateSnapshot['activeStreams'] = []
  let heldStreamCount = 0
  let heldAckChars = 0
  for (const [environmentId, multiplexer] of multiplexers) {
    for (const stream of multiplexer.getStreamsForE2e()) {
      activeStreams.push({ environmentId, streamId: stream.streamId, terminal: stream.terminal })
      if (stream.heldAckBytes > 0) {
        heldStreamCount += 1
        heldAckChars += stream.heldAckBytes
      }
    }
  }
  return {
    activeStreams,
    droppedOutputBytes: e2eDroppedOutputBytes,
    droppedOutputFrames: e2eDroppedOutputFrames,
    heldTerminalCount: e2eHeldRemoteAckTerminals.size,
    heldStreamCount,
    heldAckChars,
    releasedAckChars: e2eReleasedRemoteAckChars,
    streamSubscribeCount: e2eStreamSubscribeCount,
    streamUnsubscribeCount: e2eStreamUnsubscribeCount,
    initialSnapshotTruncatedCount: e2eInitialSnapshotTruncatedCount,
    transportSubscribeCount: e2eTransportSubscribeCount,
    transportUnsubscribeCount: e2eTransportUnsubscribeCount
  }
}

export function recordE2eRemoteTerminalInitialSnapshotTruncated(): void {
  if (e2eConfig.exposeStore) {
    e2eInitialSnapshotTruncatedCount += 1
  }
}

export function recordE2eRemoteTransportSubscribe(): void {
  if (e2eConfig.exposeStore) {
    e2eTransportSubscribeCount += 1
  }
}

export function unsubscribeRuntimeEnvironmentForE2e(
  subscription: RuntimeEnvironmentSubscriptionHandle
): void {
  if (e2eConfig.exposeStore) {
    e2eTransportUnsubscribeCount += 1
  }
  subscription.unsubscribe()
}

export function recordE2eRemoteStreamFrame(opcode: TerminalStreamOpcode): void {
  if (!e2eConfig.exposeStore) {
    return
  }
  if (opcode === TerminalStreamOpcode.Subscribe) {
    e2eStreamSubscribeCount += 1
  } else if (opcode === TerminalStreamOpcode.Unsubscribe) {
    e2eStreamUnsubscribeCount += 1
  }
}

function releaseE2eRemoteTerminalAcks(
  multiplexers: ReadonlyMap<string, RemoteRuntimeTerminalMultiplexerE2eAccess>
): void {
  for (const multiplexer of multiplexers.values()) {
    e2eReleasedRemoteAckChars += multiplexer.releaseHeldAcksForE2e()
  }
  e2eHeldRemoteAckTerminals.clear()
}

function resetE2eDroppedRemoteOutput(): void {
  e2eDroppedOutputStreams.clear()
  e2eDroppedOutputBytes = 0
  e2eDroppedOutputFrames = 0
}

export function shouldDropE2eRemoteTerminalOutput(
  stream: RemoteRuntimeMultiplexedTerminalState,
  bytes: number
): boolean {
  if (!e2eConfig.exposeStore || !e2eDroppedOutputStreams.has(stream)) {
    return false
  }
  e2eDroppedOutputBytes += bytes
  e2eDroppedOutputFrames += 1
  return true
}

export function exposeE2eRemoteTerminalMultiplexAckGate(
  multiplexers: ReadonlyMap<string, RemoteRuntimeTerminalMultiplexerE2eAccess>
): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const target = window as E2eRemoteTerminalMultiplexAckGateWindow
  target.__remoteTerminalMultiplexAckGate ??= {
    dropOutputUntilResubscribe: (terminals) => {
      resetE2eDroppedRemoteOutput()
      const targets = new Set(terminals)
      for (const multiplexer of multiplexers.values()) {
        for (const stream of multiplexer.getStreamsForE2e()) {
          if (targets.has(stream.terminal)) {
            e2eDroppedOutputStreams.add(stream)
          }
        }
      }
      return e2eDroppedOutputStreams.size
    },
    forceError: (terminals, message) => {
      let dispatched = 0
      const targets = new Set(terminals)
      for (const multiplexer of multiplexers.values()) {
        dispatched += multiplexer.forceErrorForE2e(targets, message)
      }
      return dispatched
    },
    hold: (terminals) => {
      releaseE2eRemoteTerminalAcks(multiplexers)
      for (const terminal of terminals) {
        e2eHeldRemoteAckTerminals.add(terminal)
      }
    },
    holdEnd: (terminals) => {
      e2eHeldRemoteEndTerminals.clear()
      for (const terminal of terminals) {
        e2eHeldRemoteEndTerminals.add(terminal)
      }
    },
    release: () => {
      releaseE2eRemoteTerminalAcks(multiplexers)
      resetE2eDroppedRemoteOutput()
      e2eHeldRemoteEndTerminals.clear()
    },
    sendInput: (terminal, value) => {
      let sent = 0
      for (const multiplexer of multiplexers.values()) {
        sent += multiplexer.sendInputForE2e(terminal, value)
      }
      return sent
    },
    snapshot: () => getE2eRemoteAckSnapshot(multiplexers)
  }
}

export function resetRemoteRuntimeTerminalE2eState(): void {
  e2eHeldRemoteAckTerminals.clear()
  resetE2eDroppedRemoteOutput()
  e2eReleasedRemoteAckChars = 0
  e2eStreamSubscribeCount = 0
  e2eStreamUnsubscribeCount = 0
  e2eInitialSnapshotTruncatedCount = 0
  e2eTransportSubscribeCount = 0
  e2eTransportUnsubscribeCount = 0
}
