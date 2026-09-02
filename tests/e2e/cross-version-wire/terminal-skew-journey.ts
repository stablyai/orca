import { expect, vi } from 'vitest'
import {
  createHostTerminalRuntimeStub,
  type HostTerminalRuntimeStub
} from './host-terminal-runtime-stub'
import {
  createTerminalWireLink,
  type ObservedFrame,
  type RejectedFrame
} from './terminal-wire-link'
import type { ClientTerminal, TerminalWireBuild } from './versioned-terminal-wire'

export const JOURNEY_STEPS = [
  'subscribe',
  'first-snapshot',
  'input-reaches-process',
  'live-output',
  'reveal-snapshot',
  'transport-drop',
  'resubscribe',
  'input-after-reconnect'
] as const

export type JourneyStep = (typeof JOURNEY_STEPS)[number]

const TERMINAL_HANDLE = 'terminal-journey'
const FIRST_INPUT = 'echo cross-version\r'
const SECOND_INPUT = 'echo after-reconnect\r'
const LIVE_OUTPUT = 'cross-version live output\r\n'
const INITIAL_BUFFER = 'initial scrollback\r\n'
const BARRIER_TIMEOUT_MS = 10_000

export type JourneyRecord = {
  hostLabel: string
  clientLabel: string
  hostRevision: string
  clientRevision: string
  /** Steps that actually completed, in order. The liveness oracle. */
  completed: JourneyStep[]
  /** `subscribed` events the client accepted, including negotiated capabilities. */
  subscribedEvents: Record<string, unknown>[]
  /** SnapshotStart payloads as the CLIENT decoded them — the published projection. */
  snapshotStarts: Record<string, unknown>[]
  /** Snapshot bodies handed to the pane. */
  snapshotsRendered: string[]
  /** Live output the client's pane received. */
  dataRendered: string[]
  /** Exact texts the host wrote to the PTY. */
  inputAtProcess: string[]
  /** Snapshot the reveal step resolved with. */
  revealSnapshot: { data: string; cols: number; rows: number } | null
  transportCloses: number
  clientErrors: string[]
  observed: ObservedFrame[]
  /** Observed frames as `C>H Input` / `H>C SnapshotStart`, in delivery order. */
  frameSequence: string[]
  rejected: RejectedFrame[]
  missingRuntimeMethods: string[]
}

function nameOpcode(build: TerminalWireBuild, opcode: number): string {
  const name = build.codec.TerminalStreamOpcode[opcode]
  return typeof name === 'string' ? name : `Opcode${opcode}`
}

/**
 * A pairing that never advanced. Carries the partial record so a caller can read
 * what the wire actually did — which frames the receiving decoder refused, and
 * which steps completed before the stall.
 */
export class CrossVersionJourneyStall extends Error {
  readonly step: JourneyStep
  readonly record: JourneyRecord

  constructor(step: JourneyStep, detail: string, record: JourneyRecord) {
    super(`Cross-version journey stalled at ${step}: ${detail}`)
    this.name = 'CrossVersionJourneyStall'
    this.step = step
    this.record = record
  }
}

/**
 * Drive one terminal journey with a fixed script, so the same byte-identical oracle
 * runs for every host/client version pairing:
 *
 *   subscribe -> first snapshot -> input reaches the process -> live output ->
 *   hide/reveal snapshot -> transport drop -> resubscribe -> input still lands.
 *
 * Every step ends on an observed-state barrier, never on elapsed time.
 */
export async function runTerminalSkewJourney(args: {
  hostBuild: TerminalWireBuild
  clientBuild: TerminalWireBuild
  /** Only lower this for a pairing whose stall is the expected outcome. */
  barrierTimeoutMs?: number
}): Promise<JourneyRecord> {
  const { hostBuild, clientBuild } = args
  const barrierTimeoutMs = args.barrierTimeoutMs ?? BARRIER_TIMEOUT_MS
  const hostStub: HostTerminalRuntimeStub = createHostTerminalRuntimeStub({
    terminalHandle: TERMINAL_HANDLE,
    initialBuffer: INITIAL_BUFFER
  })
  const link = createTerminalWireLink({ hostBuild, clientBuild, hostStub })

  const record: JourneyRecord = {
    hostLabel: hostBuild.label,
    clientLabel: clientBuild.label,
    hostRevision: hostBuild.revision,
    clientRevision: clientBuild.revision,
    completed: [],
    subscribedEvents: [],
    snapshotStarts: [],
    snapshotsRendered: [],
    dataRendered: [],
    inputAtProcess: hostStub.writtenInput,
    revealSnapshot: null,
    transportCloses: 0,
    clientErrors: [],
    observed: link.observed,
    frameSequence: [],
    rejected: link.rejected,
    missingRuntimeMethods: hostStub.missingRuntimeMethods
  }

  const barrier = async (
    step: JourneyStep,
    detail: string,
    predicate: () => boolean
  ): Promise<void> => {
    try {
      await vi.waitFor(() => expect(predicate()).toBe(true), {
        timeout: barrierTimeoutMs,
        interval: 5
      })
    } catch {
      throw new CrossVersionJourneyStall(step, detail, record)
    }
  }

  // Name opcodes with whichever build knows more of them, so an unknown opcode in
  // the journey reads as `Opcode17` instead of silently borrowing a wrong name.
  const namingBuild =
    Object.keys(clientBuild.codec.TerminalStreamOpcode).length >=
    Object.keys(hostBuild.codec.TerminalStreamOpcode).length
      ? clientBuild
      : hostBuild
  const collectFrameSequence = (): void => {
    record.frameSequence = link.observed.map(
      (frame) =>
        `${frame.direction === 'host-to-client' ? 'H>C' : 'C>H'} ${nameOpcode(namingBuild, frame.opcode)}`
    )
  }

  const snapshotStartOpcode = Number(clientBuild.codec.TerminalStreamOpcode.SnapshotStart)
  const collectSnapshotStarts = (): void => {
    record.snapshotStarts = link.observed
      .filter(
        (frame) => frame.direction === 'host-to-client' && frame.opcode === snapshotStartOpcode
      )
      .map((frame) => frame.json ?? {})
  }

  let subscribedCount = 0
  const callbacks = {
    onData: (data: string) => {
      record.dataRendered.push(data)
    },
    onSnapshot: (data: string) => {
      record.snapshotsRendered.push(data)
    },
    onSubscribed: () => {
      subscribedCount++
    },
    onError: (message: string) => {
      record.clientErrors.push(message)
    },
    onTransportClose: () => {
      record.transportCloses++
    }
  }

  const subscribe = async (): Promise<ClientTerminal> =>
    clientBuild.client
      .getRemoteRuntimeTerminalMultiplexer('cross-version-runtime')
      .subscribeTerminal({
        terminal: TERMINAL_HANDLE,
        client: { id: 'cross-version-client', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        callbacks
      })

  try {
    let terminal = await subscribe()
    await barrier('subscribe', 'client never saw a `subscribed` event', () => subscribedCount >= 1)
    record.subscribedEvents = link.connections.flatMap((connection) =>
      connection.events.filter((event) => event.type === 'subscribed')
    )
    record.completed.push('subscribe')

    await barrier(
      'first-snapshot',
      'client never rendered the initial buffer snapshot',
      () => record.snapshotsRendered.length >= 1
    )
    record.completed.push('first-snapshot')

    terminal.sendInput(FIRST_INPUT)
    await barrier('input-reaches-process', 'host never wrote the client input to the PTY', () =>
      hostStub.writtenInput.includes(FIRST_INPUT)
    )
    record.completed.push('input-reaches-process')

    hostStub.emitOutput(LIVE_OUTPUT)
    await barrier('live-output', 'client never rendered host output', () =>
      record.dataRendered.join('').includes(LIVE_OUTPUT.trim())
    )
    record.completed.push('live-output')

    // Hide/reveal: the pane drops xterm and asks the host to re-publish the buffer.
    const revealed = await terminal.serializeBuffer({ scrollbackRows: 200 })
    if (!revealed) {
      throw new Error('reveal-snapshot: host returned no buffer snapshot on reveal')
    }
    record.revealSnapshot = { data: revealed.data, cols: revealed.cols, rows: revealed.rows }
    record.completed.push('reveal-snapshot')

    const closesBeforeDrop = record.transportCloses
    link.disconnect()
    await barrier(
      'transport-drop',
      'client never observed the transport close',
      () => record.transportCloses > closesBeforeDrop
    )
    record.completed.push('transport-drop')

    const subscribedBeforeReconnect = subscribedCount
    terminal = await subscribe()
    await barrier(
      'resubscribe',
      'client never re-established the stream after reconnect',
      () => subscribedCount > subscribedBeforeReconnect
    )
    record.subscribedEvents = link.connections.flatMap((connection) =>
      connection.events.filter((event) => event.type === 'subscribed')
    )
    record.completed.push('resubscribe')

    terminal.sendInput(SECOND_INPUT)
    await barrier('input-after-reconnect', 'host never wrote post-reconnect input to the PTY', () =>
      hostStub.writtenInput.includes(SECOND_INPUT)
    )
    record.completed.push('input-after-reconnect')

    terminal.close()
  } finally {
    collectSnapshotStarts()
    collectFrameSequence()
    await link.dispose()
  }

  return record
}

export const JOURNEY_INPUTS = {
  first: FIRST_INPUT,
  second: SECOND_INPUT,
  output: LIVE_OUTPUT,
  initialBuffer: INITIAL_BUFFER
}
