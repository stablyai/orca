import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  capturePublishedRestoreRequiredFailure,
  driveClientReattachFailure,
  SKEW_PANE,
  type ClientReattachFailureOutcome
} from './reattach-failure-publication-skew'
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

/**
 * The opcode journey above proves frames survive skew. It cannot see this: the
 * failure token a reattach publishes is a plain string on an existing error
 * channel, so nothing is rejected and nothing negotiates — yet the token decides
 * whether the receiving client asks the host to REPLACE the pane's shell.
 */
function expectDriveActuallyRan(outcome: ClientReattachFailureOutcome): void {
  expect(outcome.connectedBeforeFault).toBe(true)
  expect(outcome.subscribedHandles[0]).toBe(SKEW_PANE.handle)
  expect(outcome.methodsAfterFailure).toContain('terminal.resolvePane')
}

describe('cross-version reattach failure publication', () => {
  let currentPublication: string
  let baselinePublication: string

  beforeAll(async () => {
    currentPublication = await capturePublishedRestoreRequiredFailure(current)
    baselinePublication = await capturePublishedRestoreRequiredFailure(baseline)
  }, SUITE_TIMEOUT_MS)

  it(
    'the two builds publish different tokens for the same live-shell reattach',
    () => {
      // Guards the whole block: identical publications would make every case below
      // pass for a reason that has nothing to do with skew.
      expect(currentPublication).not.toBe(baselinePublication)
      expect(baselinePublication).toContain('SSH_SESSION_EXPIRED')
      expect(currentPublication).not.toContain('SSH_SESSION_EXPIRED')
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'the new host publication mutates nothing on an old client',
    async () => {
      const outcome = await driveClientReattachFailure({
        clientBuild: baseline,
        publishedFailure: currentPublication
      })
      expectDriveActuallyRan(outcome)
      // The old client has no branch for this token, so it stops at its error
      // surface — unsupported semantics failing before mutation, not adopting a
      // replacement shell it was never granted. It fails visibly rather than
      // silently, which is the difference between "fenced" and "dropped".
      expect(outcome.paneReplacementRequests).toEqual([])
      expect(outcome.subscribedHandles).not.toContain(SKEW_PANE.replacementHandle)
      expect(outcome.surfacedErrors).toHaveLength(1)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'the new host publication mutates nothing on a new client',
    async () => {
      const outcome = await driveClientReattachFailure({
        clientBuild: current,
        publishedFailure: currentPublication
      })
      expectDriveActuallyRan(outcome)
      expect(outcome.paneReplacementRequests).toEqual([])
      expect(outcome.subscribedHandles).not.toContain(SKEW_PANE.replacementHandle)
      expect(outcome.surfacedErrors).toHaveLength(1)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'the old host publication still replaces the pane on both clients',
    async () => {
      // The control that keeps the two cases above honest. The same driver, the
      // same fault, the same clients: only the publishing build differs, and the
      // legacy token still authorizes `terminal.recoverPane`. If the current host
      // regressed to publishing expiry for a live shell, the cases above would
      // look exactly like this one and fail.
      for (const clientBuild of [baseline, current]) {
        const outcome = await driveClientReattachFailure({
          clientBuild,
          publishedFailure: baselinePublication
        })
        expectDriveActuallyRan(outcome)
        expect(outcome.paneReplacementRequests).toEqual([
          {
            paneKey: SKEW_PANE.paneKey,
            worktreeId: SKEW_PANE.worktreeId,
            expectedTerminal: SKEW_PANE.handle
          }
        ])
        expect(outcome.subscribedHandles).toContain(SKEW_PANE.replacementHandle)
      }
    },
    SUITE_TIMEOUT_MS
  )
})
