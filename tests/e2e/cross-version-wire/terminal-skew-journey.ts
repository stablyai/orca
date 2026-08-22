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
  'transformed-output',
  'large-transformed-output',
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
// A transformed run: the host consumed TRANSFORMED_RAW_LENGTH raw code units and has
// this much left to display. `rawLength !== display.length` is the shape that decides
// OutputSpan vs plain Output, and it had no cross-version coverage before STA-3482.
const TRANSFORMED_OUTPUT = 'transformed run\r\n'
const TRANSFORMED_RAW_LENGTH = TRANSFORMED_OUTPUT.length + 31
// Past TERMINAL_STREAM_CHUNK_BYTES (48 KiB) so the transformed run must be split; the
// multi-frame arm is where a dropped yield loses a whole chunk of user output.
const LARGE_TRANSFORMED_OUTPUT = `HEAD${'x'.repeat(64 * 1024)}TAIL\r\n`
const LARGE_TRANSFORMED_RAW_LENGTH = LARGE_TRANSFORMED_OUTPUT.length + 97
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
  /** Per-delivery `(rawLength, transformed)` as the CLIENT reconstructed them. */
  dataMeta: { length: number; rawLength?: number; transformed?: boolean }[]
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

async function barrier(label: string, predicate: () => boolean): Promise<void> {
  try {
    await vi.waitFor(() => expect(predicate()).toBe(true), {
      timeout: BARRIER_TIMEOUT_MS,
      interval: 5
    })
  } catch {
    throw new Error(`Cross-version journey stalled at barrier: ${label}`)
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
}): Promise<JourneyRecord> {
  const { hostBuild, clientBuild } = args
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
    dataMeta: [],
    inputAtProcess: hostStub.writtenInput,
    revealSnapshot: null,
    transportCloses: 0,
    clientErrors: [],
    observed: link.observed,
    frameSequence: [],
    rejected: link.rejected,
    missingRuntimeMethods: hostStub.missingRuntimeMethods
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
    onData: (data: string, meta?: { rawLength?: number; transformed?: boolean }) => {
      record.dataRendered.push(data)
      record.dataMeta.push({
        length: data.length,
        rawLength: meta?.rawLength,
        transformed: meta?.transformed
      })
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
    await barrier('subscribe: client never saw a `subscribed` event', () => subscribedCount >= 1)
    record.subscribedEvents = link.connections.flatMap((connection) =>
      connection.events.filter((event) => event.type === 'subscribed')
    )
    record.completed.push('subscribe')

    await barrier(
      'first-snapshot: client never rendered the initial buffer snapshot',
      () => record.snapshotsRendered.length >= 1
    )
    record.completed.push('first-snapshot')

    terminal.sendInput(FIRST_INPUT)
    await barrier('input-reaches-process: host never wrote the client input to the PTY', () =>
      hostStub.writtenInput.includes(FIRST_INPUT)
    )
    record.completed.push('input-reaches-process')

    hostStub.emitOutput(LIVE_OUTPUT)
    await barrier('live-output: client never rendered host output', () =>
      record.dataRendered.join('').includes(LIVE_OUTPUT.trim())
    )
    record.completed.push('live-output')

    hostStub.emitTransformedOutput(TRANSFORMED_OUTPUT, TRANSFORMED_RAW_LENGTH)
    await barrier('transformed-output: client never rendered the transformed run', () =>
      record.dataRendered.join('').includes(TRANSFORMED_OUTPUT.trim())
    )
    record.completed.push('transformed-output')

    hostStub.emitTransformedOutput(LARGE_TRANSFORMED_OUTPUT, LARGE_TRANSFORMED_RAW_LENGTH)
    await barrier(
      'large-transformed-output: client never rendered the full multi-chunk transformed run',
      () => record.dataRendered.join('').includes(LARGE_TRANSFORMED_OUTPUT)
    )
    record.completed.push('large-transformed-output')

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
      'transport-drop: client never observed the transport close',
      () => record.transportCloses > closesBeforeDrop
    )
    record.completed.push('transport-drop')

    const subscribedBeforeReconnect = subscribedCount
    terminal = await subscribe()
    await barrier(
      'resubscribe: client never re-established the stream after reconnect',
      () => subscribedCount > subscribedBeforeReconnect
    )
    record.subscribedEvents = link.connections.flatMap((connection) =>
      connection.events.filter((event) => event.type === 'subscribed')
    )
    record.completed.push('resubscribe')

    terminal.sendInput(SECOND_INPUT)
    await barrier('input-after-reconnect: host never wrote post-reconnect input to the PTY', () =>
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
  transformed: TRANSFORMED_OUTPUT,
  transformedRawLength: TRANSFORMED_RAW_LENGTH,
  largeTransformed: LARGE_TRANSFORMED_OUTPUT,
  largeTransformedRawLength: LARGE_TRANSFORMED_RAW_LENGTH,
  initialBuffer: INITIAL_BUFFER
}
