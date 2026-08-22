import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveBaselineReleaseRef, selectLatestStableReleaseTag } from './release-checkout'
import {
  JOURNEY_INPUTS,
  JOURNEY_STEPS,
  runTerminalSkewJourney,
  type JourneyRecord
} from './terminal-skew-journey'
import {
  loadTerminalWireBuild,
  WORKING_TREE,
  type TerminalWireBuild
} from './versioned-terminal-wire'

// Why: a cold CI run extracts the baseline checkout before the first journey.
const SUITE_TIMEOUT_MS = 180_000

/**
 * The frames one journey must produce, named rather than numbered so a diff reads
 * as a protocol change. Any deviation is a change in what a peer publishes or
 * accepts, and needs a human decision against docs/reference/remote-wire-compatibility.md.
 */
const EXPECTED_JOURNEY_FRAMES = [
  'C>H Subscribe',
  'H>C SnapshotStart',
  'H>C SnapshotChunk',
  'H>C SnapshotEnd',
  'C>H Input',
  'H>C Output',
  // A transformed run (rawLength !== data.length) must travel as OutputSpan on multiplex.
  // If this ever reads `H>C Output`, a host downgraded a run it cannot losslessly downgrade.
  'H>C OutputSpan',
  'H>C OutputSpan',
  'C>H SnapshotRequest',
  // Two chunks from here on: the large transformed run pushed the scrollback past one.
  'H>C SnapshotStart',
  'H>C SnapshotChunk',
  'H>C SnapshotChunk',
  'H>C SnapshotEnd',
  'C>H Subscribe',
  'H>C SnapshotStart',
  'H>C SnapshotChunk',
  'H>C SnapshotChunk',
  'H>C SnapshotEnd',
  'C>H Input',
  'C>H Unsubscribe'
]

// Stable across every build pairing in this suite; the codec never renumbers an opcode.
const SNAPSHOT_REQUEST_OPCODE = 11

let baselineRef: string
let current: TerminalWireBuild
let baseline: TerminalWireBuild

beforeAll(async () => {
  baselineRef = resolveBaselineReleaseRef()
  current = await loadTerminalWireBuild(WORKING_TREE)
  baseline = await loadTerminalWireBuild(baselineRef)
}, SUITE_TIMEOUT_MS)

afterEach(() => {
  // Each journey installs and removes its own window stub; fail loudly if one leaked.
  expect(typeof globalThis.window).toBe('undefined')
})

function expectJourneyActuallyRan(record: JourneyRecord): void {
  // The anti-vacuous-pass oracle. A harness that connects and then does nothing
  // fails here, because "nothing threw" is never enough to call a pairing green.
  expect(record.completed).toEqual([...JOURNEY_STEPS])
  expect(record.frameSequence).toEqual(EXPECTED_JOURNEY_FRAMES)
  expect(record.subscribedEvents).toHaveLength(2)
  expect(record.snapshotStarts).toHaveLength(3)
  expect(record.missingRuntimeMethods).toEqual([])
}

function expectWireCompatible(record: JourneyRecord): void {
  // Rule 2 — no frame may be refused by the receiving build's decoder. An opcode
  // the peer does not know is dropped silently, so this is the only signal.
  expect(record.rejected).toEqual([])
  expect(record.clientErrors).toEqual([])

  // The subscribe handshake still negotiates the optional output-pause opcode,
  // which is what keeps opcode 16 legal to send on this pairing.
  for (const event of record.subscribedEvents) {
    expect(event.capabilities).toEqual({ outputPause: 1 })
  }

  // Input reached the process, before and after the reconnect.
  expect(record.inputAtProcess).toEqual([JOURNEY_INPUTS.first, JOURNEY_INPUTS.second])

  // Rule 3 — what the host publishes, as the client actually rendered it.
  expect(record.snapshotsRendered[0]).toBe(JOURNEY_INPUTS.initialBuffer)
  expect(record.dataRendered.join('')).toBe(
    `${JOURNEY_INPUTS.output}${JOURNEY_INPUTS.transformed}${JOURNEY_INPUTS.largeTransformed}`
  )
  expect(record.revealSnapshot?.data).toBe(
    `${JOURNEY_INPUTS.initialBuffer}${JOURNEY_INPUTS.output}${JOURNEY_INPUTS.transformed}${JOURNEY_INPUTS.largeTransformed}`
  )

  // The transformed runs arrived whole and carried their RAW length, not their display
  // length. A downgraded run would report `rawLength === length`, which makes the client
  // reconstruct a start past its high-water mark and read a dropped-frame gap.
  const transformed = record.dataMeta.filter((entry) => entry.transformed)
  expect(transformed).toEqual([
    {
      length: JOURNEY_INPUTS.transformed.length,
      rawLength: JOURNEY_INPUTS.transformedRawLength,
      transformed: true
    },
    {
      length: JOURNEY_INPUTS.largeTransformed.length,
      rawLength: JOURNEY_INPUTS.largeTransformedRawLength,
      transformed: true
    }
  ])
  // A false gap self-heals by pulling a fresh snapshot, which would show up as an extra
  // client -> host SnapshotRequest. Only the scripted hide/reveal may issue one.
  expect(
    record.observed.filter(
      (frame) => frame.direction === 'client-to-host' && frame.opcode === SNAPSHOT_REQUEST_OPCODE
    )
  ).toHaveLength(1)
  expect(record.revealSnapshot).toMatchObject({ cols: 120, rows: 40 })
  for (const start of record.snapshotStarts) {
    expect(start).toMatchObject({ kind: 'scrollback', cols: 120, rows: 40, source: 'headless' })
  }
}

describe('cross-version remote terminal wire', () => {
  it('ignores legacy, mobile, and prerelease tags when selecting the baseline', () => {
    expect(
      selectLatestStableReleaseTag([
        'v799',
        'mobile-v9.0.0',
        'v1.4.177-rc.3',
        'v1.4.175',
        'v1.4.176'
      ])
    ).toBe('v1.4.176')
  })

  it(
    'skews current code against a real published release',
    () => {
      expect(baselineRef).toMatch(/^v?\d/)
      expect(baseline.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(baseline.revision).not.toBe(current.revision)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'current client against current server completes the journey',
    async () => {
      const record = await runTerminalSkewJourney({ hostBuild: current, clientBuild: current })
      expectJourneyActuallyRan(record)
      expectWireCompatible(record)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'old client against new server completes the journey',
    async () => {
      const record = await runTerminalSkewJourney({ hostBuild: current, clientBuild: baseline })
      expect(record.clientRevision).toBe(baseline.revision)
      expectJourneyActuallyRan(record)
      expectWireCompatible(record)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'new client against old server completes the journey',
    async () => {
      const record = await runTerminalSkewJourney({ hostBuild: baseline, clientBuild: current })
      expect(record.hostRevision).toBe(baseline.revision)
      expectJourneyActuallyRan(record)
      expectWireCompatible(record)
    },
    SUITE_TIMEOUT_MS
  )
})
