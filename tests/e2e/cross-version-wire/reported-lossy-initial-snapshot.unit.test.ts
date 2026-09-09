import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { createHostTerminalRuntimeStub } from './host-terminal-runtime-stub'
import { createTerminalWireLink } from './terminal-wire-link'
import {
  loadTerminalWireBuild,
  WORKING_TREE,
  type TerminalWireBuild
} from './versioned-terminal-wire'

const REPORTED_CLIENT_REF = '4cb013c0a9'
const REPORTED_HOST_REF = '4bb337741c'
const PRE_FIX_MAIN_REF = 'fd9125ea8c'
const MARKER = 'REPORTED_LOSSY_INITIAL_MARKER'
const RECOVERED_LIVE_MARKER = 'RECOVERED_LIVE_AFTER_INITIAL'
const CONTINUED_LIVE_MARKER = 'CONTINUED_LIVE_AFTER_RECOVERY'
const TIMEOUT_MS = 180_000

let candidate: TerminalWireBuild
let preFixMain: TerminalWireBuild
let reportedClient: TerminalWireBuild
let reportedHost: TerminalWireBuild

beforeAll(async () => {
  ;[candidate, preFixMain, reportedClient, reportedHost] = await Promise.all([
    loadTerminalWireBuild(WORKING_TREE),
    loadTerminalWireBuild(PRE_FIX_MAIN_REF),
    loadTerminalWireBuild(REPORTED_CLIENT_REF),
    loadTerminalWireBuild(REPORTED_HOST_REF)
  ])
}, TIMEOUT_MS)

afterEach(() => {
  expect(typeof globalThis.window).toBe('undefined')
})

async function runLossyInitialSnapshotPair(args: {
  clientBuild: TerminalWireBuild
  hostBuild: TerminalWireBuild
  exerciseLiveRecovery?: boolean
}): Promise<{
  frames: string[]
  missingRuntimeMethods: string[]
  rejected: unknown[]
  rendered: string
  snapshotStarts: Record<string, unknown>[]
  snapshots: string[]
}> {
  const hostStub = createHostTerminalRuntimeStub({
    initialBuffer: MARKER,
    overflowInitialSnapshots: true
  })
  const link = createTerminalWireLink({ ...args, hostStub })
  const snapshots: string[] = []
  const terminalModel = new Terminal({ cols: 120, rows: 40 })
  let subscribed = 0
  try {
    const terminal = await args.clientBuild.client
      .getRemoteRuntimeTerminalMultiplexer('reported-lossy-initial')
      .subscribeTerminal({
        terminal: hostStub.terminalHandle,
        client: { id: 'reported-client', type: 'desktop' },
        callbacks: {
          onData: (data) => terminalModel.write(data),
          onSnapshot: (data) => {
            snapshots.push(data)
            terminalModel.write(data)
          },
          onSubscribed: () => {
            subscribed += 1
          }
        }
      })
    await vi.waitFor(() => expect(subscribed).toBe(1), { timeout: 10_000 })
    if (args.exerciseLiveRecovery) {
      hostStub.emitOutput(RECOVERED_LIVE_MARKER)
      await vi.waitFor(
        () => expect(readTerminalText(terminalModel)).toContain(RECOVERED_LIVE_MARKER),
        { timeout: 10_000 }
      )
      hostStub.emitOutput(CONTINUED_LIVE_MARKER)
      await vi.waitFor(
        () => expect(readTerminalText(terminalModel)).toContain(CONTINUED_LIVE_MARKER),
        { timeout: 10_000 }
      )
    }
    terminal.close()
    const snapshotStartOpcode = Number(args.clientBuild.codec.TerminalStreamOpcode.SnapshotStart)
    return {
      frames: link.observed.map((frame) => {
        const codec =
          frame.direction === 'host-to-client' ? args.clientBuild.codec : args.hostBuild.codec
        const name = codec.TerminalStreamOpcode[frame.opcode]
        return `${frame.direction}:${typeof name === 'string' ? name : frame.opcode}`
      }),
      missingRuntimeMethods: hostStub.missingRuntimeMethods,
      rejected: link.rejected,
      rendered: readTerminalText(terminalModel),
      snapshotStarts: link.observed
        .filter(
          (frame) => frame.direction === 'host-to-client' && frame.opcode === snapshotStartOpcode
        )
        .map((frame) => frame.json ?? {}),
      snapshots
    }
  } finally {
    terminalModel.dispose()
    await link.dispose()
  }
}

function readTerminalText(terminal: Terminal): string {
  const lines: string[] = []
  for (let index = 0; index < terminal.buffer.active.length; index += 1) {
    lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
}

describe('reported mixed-version lossy initial snapshot', () => {
  it(
    'reconstructs the blank 1.4.192-client / 1.4.191-host boundary',
    async () => {
      const record = await runLossyInitialSnapshotPair({
        clientBuild: reportedClient,
        hostBuild: reportedHost
      })

      expect(record.snapshotStarts).toEqual([
        expect.objectContaining({ truncated: true, seq: expect.any(Number) })
      ])
      expect(record.frames).toEqual([
        'client-to-host:Subscribe',
        'host-to-client:SnapshotStart',
        'host-to-client:SnapshotChunk',
        'host-to-client:SnapshotEnd',
        'client-to-host:Unsubscribe'
      ])
      expect(record.snapshots).toEqual([])
      expect(record.rendered.trim()).toBe('')
    },
    TIMEOUT_MS
  )

  it(
    'reproduces the blank terminal with the exact pre-fix main client',
    async () => {
      const record = await runLossyInitialSnapshotPair({
        clientBuild: preFixMain,
        hostBuild: reportedHost
      })

      expect(record.snapshotStarts).toEqual([
        expect.objectContaining({ truncated: true, seq: expect.any(Number) })
      ])
      expect(record.frames).toEqual([
        'client-to-host:Subscribe',
        'host-to-client:SnapshotStart',
        'host-to-client:SnapshotChunk',
        'host-to-client:SnapshotEnd',
        'client-to-host:Unsubscribe'
      ])
      expect(record.snapshots).toEqual([])
      expect(record.rendered.trim()).toBe('')
    },
    TIMEOUT_MS
  )

  it(
    'paints the old host image exactly once with the candidate client',
    async () => {
      const record = await runLossyInitialSnapshotPair({
        clientBuild: candidate,
        hostBuild: reportedHost,
        exerciseLiveRecovery: true
      })

      expect(record.snapshotStarts).toEqual([
        expect.objectContaining({ truncated: true, seq: expect.any(Number) }),
        expect.objectContaining({ truncated: false, seq: expect.any(Number) })
      ])
      expect(record.snapshots[0]).toBe(MARKER)
      expect(record.rejected).toEqual([])
      expect(record.missingRuntimeMethods).toEqual([])
      expect(record.rendered.split(MARKER)).toHaveLength(2)
      expect(record.rendered.split(RECOVERED_LIVE_MARKER)).toHaveLength(2)
      expect(record.rendered.split(CONTINUED_LIVE_MARKER)).toHaveLength(2)
    },
    TIMEOUT_MS
  )

  it(
    'paints the latest host image exactly once with the candidate client',
    async () => {
      const record = await runLossyInitialSnapshotPair({
        clientBuild: candidate,
        hostBuild: candidate,
        exerciseLiveRecovery: true
      })

      expect(record.snapshotStarts).toEqual([
        expect.objectContaining({ truncated: true, seq: expect.any(Number) }),
        expect.objectContaining({ truncated: false, seq: expect.any(Number) })
      ])
      expect(record.snapshots[0]).toBe(MARKER)
      expect(record.rejected).toEqual([])
      expect(record.missingRuntimeMethods).toEqual([])
      expect(record.rendered.split(MARKER)).toHaveLength(2)
      expect(record.rendered.split(RECOVERED_LIVE_MARKER)).toHaveLength(2)
      expect(record.rendered.split(CONTINUED_LIVE_MARKER)).toHaveLength(2)
    },
    TIMEOUT_MS
  )
})
