import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { comparePublishedFieldOccurrences, publishedFieldNames } from './published-field-shape'
import { resolveBaselineReleaseRef } from './release-checkout'
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
// Last stable release before SnapshotStart began publishing terminal mode metadata.
const TERMINAL_MODE_METADATA_LEGACY_REF = 'v1.4.190'

// Name each journey’s expected frames; changed publication/acceptance needs review against remote-wire-compatibility.md.
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
  // Require an observable journey so an inert harness cannot make every pairing pass.
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
  // Refused opcodes drop silently, so assert the receiving decoder accepts every frame.
  expect(record.rejected).toEqual([])
  expect(record.clientErrors).toEqual([])

  // Negotiate output-pause before opcode 16; drop notices require both peers to know the pause extension.
  for (const event of record.subscribedEvents) {
    expect(event.capabilities).toMatchObject({ outputPause: 1 })
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
  it('current client against current server completes the journey, and is the reference for a current host', () => {
    expectJourneyActuallyRan(currentReference)
    expectWireCompatible(currentReference)
    for (const event of currentReference.subscribedEvents) {
      expect(event.capabilities).toEqual({ outputPause: 1, outputPauseDropNotice: 1 })
    }
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
      expect(record.snapshotStarts).toEqual(baselineReference.snapshotStarts)
    },
    SUITE_TIMEOUT_MS
  )

  it('adds SnapshotStart fields rather than dropping ones the old host still publishes', () => {
    expectSnapshotStartFieldsRemainPublished({
      older: baselineReference.snapshotStarts,
      newer: currentReference.snapshotStarts,
      olderLabel: baselineRef,
      newerLabel: 'current code'
    })
  })

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
