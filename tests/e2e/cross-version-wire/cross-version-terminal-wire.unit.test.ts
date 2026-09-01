// Cross-version coverage for the remote terminal stream, paired in both skew
// directions: current working tree against the newest published release.
//
// What each build publishes is read from that build, never written down here. The
// baseline is whichever release tag is newest, so a list of "fields the old side
// does not have yet" stops being true the moment a release ships one of them — the
// suite then reddens on whatever pull request is in flight, with no code change
// anywhere. Every version-dependent expectation below therefore comes from a
// same-version reference pairing of the build that publishes the frame.

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { comparePublishedFieldOccurrences, publishedFieldNames } from './published-field-shape'
import { resolveBaselineReleaseRef, selectLatestStableReleaseTag } from './release-checkout'
import {
  CrossVersionJourneyStall,
  JOURNEY_INPUTS,
  JOURNEY_STEPS,
  runTerminalSkewJourney,
  type JourneyRecord
} from './terminal-skew-journey'
import {
  loadTerminalWireBuild,
  withoutOpcodeSupport,
  WORKING_TREE,
  type TerminalWireBuild
} from './versioned-terminal-wire'

// Why: a cold CI run extracts the baseline checkout before the first journey.
const SUITE_TIMEOUT_MS = 180_000
// Last stable release before SnapshotStart began publishing terminal mode metadata.
const TERMINAL_MODE_METADATA_LEGACY_REF = 'v1.4.190'

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
  'C>H SnapshotRequest',
  'H>C SnapshotStart',
  'H>C SnapshotChunk',
  'H>C SnapshotEnd',
  'C>H Subscribe',
  'H>C SnapshotStart',
  'H>C SnapshotChunk',
  'H>C SnapshotEnd',
  'C>H Input',
  'C>H Unsubscribe'
]
const SNAPSHOT_START_OCCURRENCES = ['initial', 'reveal', 'reconnect'] as const

let baselineRef: string
let current: TerminalWireBuild
let baseline: TerminalWireBuild
/** What a current host publishes to a client of its own version. */
let currentReference: JourneyRecord
/** What the baseline host publishes to a client of its own version. */
let baselineReference: JourneyRecord
let legacyTerminalModeMetadata: TerminalWireBuild

beforeAll(async () => {
  baselineRef = resolveBaselineReleaseRef()
  const [workingTree, baselineRelease, legacyRelease] = await Promise.all([
    loadTerminalWireBuild(WORKING_TREE),
    loadTerminalWireBuild(baselineRef),
    loadTerminalWireBuild(TERMINAL_MODE_METADATA_LEGACY_REF)
  ])
  current = workingTree
  baseline = baselineRelease
  legacyTerminalModeMetadata = legacyRelease
  currentReference = await runTerminalSkewJourney({ hostBuild: current, clientBuild: current })
  baselineReference = await runTerminalSkewJourney({ hostBuild: baseline, clientBuild: baseline })
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

function expectSnapshotStartFieldsRemainPublished(args: {
  older: readonly Record<string, unknown>[]
  newer: readonly Record<string, unknown>[]
  olderLabel: string
  newerLabel: string
}): void {
  const skewByOccurrence = comparePublishedFieldOccurrences(args)
  for (const [index, skew] of skewByOccurrence.entries()) {
    const occurrence = SNAPSHOT_START_OCCURRENCES[index] ?? `occurrence ${index + 1}`
    expect(
      skew.removed,
      `${args.newerLabel} stopped publishing ${occurrence} SnapshotStart fields ` +
        `${args.olderLabel} publishes (it added: ${skew.added.join(', ') || 'nothing'})`
    ).toEqual([])
  }
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
  expect(record.dataRendered.join('')).toBe(JOURNEY_INPUTS.output)
  expect(record.revealSnapshot?.data).toBe(
    `${JOURNEY_INPUTS.initialBuffer}${JOURNEY_INPUTS.output}`
  )
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

  it('current client against current server completes the journey, and is the reference for a current host', () => {
    expectJourneyActuallyRan(currentReference)
    expectWireCompatible(currentReference)
    // Current code's own contract in both roles, so it is safe to state literally.
    expect(currentReference.snapshotStarts).toEqual([
      expect.objectContaining({ alternateScreen: false, terminalOwner: 'shell' }),
      expect.objectContaining({ alternateScreen: false, terminalOwner: 'shell' }),
      expect.objectContaining({ alternateScreen: false, terminalOwner: 'shell' })
    ])
  })

  it('old client against old server completes the journey, and is the reference for an old host', () => {
    expect(baselineReference.hostRevision).toBe(baseline.revision)
    expect(baselineReference.clientRevision).toBe(baseline.revision)
    expectJourneyActuallyRan(baselineReference)
    expectWireCompatible(baselineReference)
    // Anti-vacuous: a reference read from a pairing that published nothing would
    // make every comparison against it trivially true.
    for (const start of baselineReference.snapshotStarts) {
      expect(publishedFieldNames(start).length).toBeGreaterThan(4)
    }
  })

  it(
    'old client against new server completes the journey',
    async () => {
      const record = await runTerminalSkewJourney({ hostBuild: current, clientBuild: baseline })
      expect(record.clientRevision).toBe(baseline.revision)
      expectJourneyActuallyRan(record)
      expectWireCompatible(record)
      // Direction: the NEW host publishes here, and the old client only reads. Skew
      // must not change what that host puts on the wire, so the expectation is the
      // current host's own reference — whatever fields it carries today.
      expect(record.snapshotStarts).toEqual(currentReference.snapshotStarts)
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
      // Direction: the OLD host publishes here, and the new client only reads. Which
      // optional fields that release shipped is a property of the release, so it is
      // read from the baseline's own pairing rather than named here.
      expect(record.snapshotStarts).toEqual(baselineReference.snapshotStarts)
    },
    SUITE_TIMEOUT_MS
  )

  it('adds SnapshotStart fields rather than dropping ones the old host still publishes', () => {
    // Rule 1 is additive-only. A field the old host still publishes is one an old
    // client may still read, so dropping it breaks that client with no opcode
    // change for the decoder check to catch.
    expectSnapshotStartFieldsRemainPublished({
      older: baselineReference.snapshotStarts,
      newer: currentReference.snapshotStarts,
      olderLabel: baselineRef,
      newerLabel: 'current code'
    })
  })

  it('detects a field removed from only the reveal SnapshotStart occurrence', () => {
    const mutated = currentReference.snapshotStarts.map((start) => ({ ...start }))
    const revealIndex = SNAPSHOT_START_OCCURRENCES.indexOf('reveal')
    const reveal = mutated[revealIndex]
    if (!reveal) {
      throw new Error('The terminal journey did not publish a reveal SnapshotStart')
    }
    expect(reveal).toHaveProperty('seq')
    delete reveal.seq

    expect(() =>
      expectSnapshotStartFieldsRemainPublished({
        older: currentReference.snapshotStarts,
        newer: mutated,
        olderLabel: 'current reference',
        newerLabel: 'current mutation'
      })
    ).toThrow(/reveal SnapshotStart fields.*seq/)
  })

  it(
    'still fails a pairing whose peer cannot decode an opcode the other side sends',
    async () => {
      // The regression case for the guard itself: relaxing a stale field list must
      // not relax the real incompatibility. A short barrier only bounds a stall
      // that is already certain — the frame either arrives at once, or never.
      const inputOpcode = Number(current.codec.TerminalStreamOpcode.Input)
      const stall = await runTerminalSkewJourney({
        hostBuild: withoutOpcodeSupport(current, 'Input'),
        clientBuild: current,
        barrierTimeoutMs: 2_000
      }).then(
        () => null,
        (error: unknown) => error
      )

      expect(stall).toBeInstanceOf(CrossVersionJourneyStall)
      const stalled = stall as CrossVersionJourneyStall
      expect(stalled.step).toBe('input-reaches-process')
      expect(stalled.record.completed).not.toContain('input-reaches-process')
      expect(stalled.record.inputAtProcess).toEqual([])
      expect(stalled.record.rejected).toContainEqual(
        expect.objectContaining({ direction: 'client-to-host', rawOpcode: inputOpcode })
      )
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'new client handles a release without terminal mode metadata',
    async () => {
      const record = await runTerminalSkewJourney({
        hostBuild: legacyTerminalModeMetadata,
        clientBuild: current
      })
      expect(record.hostLabel).toBe(TERMINAL_MODE_METADATA_LEGACY_REF)
      expectJourneyActuallyRan(record)
      expectWireCompatible(record)
      for (const start of record.snapshotStarts) {
        expect(start).not.toHaveProperty('terminalOwner')
        expect(start).not.toHaveProperty('alternateScreen')
      }
    },
    SUITE_TIMEOUT_MS
  )
})
