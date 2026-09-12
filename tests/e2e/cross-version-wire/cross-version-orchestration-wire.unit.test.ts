// Cross-version coverage for the orchestration federation surface, paired the same
// way the terminal and agent-session harnesses are: current code against real
// published releases, in both skew directions, over one scripted journey.
//
// Two baselines rather than one. A worker host and the desktop that dispatches to it
// update on their own schedules, so a coordinator one release behind is an ordinary
// peer for weeks. The newest tag already contains everything fixed during the last
// cycle — pairing only against it cannot see a break introduced and repaired inside
// that window, which is exactly how the v1.4.198 coordinator losing its Run id on
// `federationAttachStart` reached users (#19689).
//
// Nothing below writes down what a release has. Every param is composed by that
// build's own coordinator module, every response by that build's own dispatcher, and
// every "the old side lacks X" is read from the extracted checkout.

import { beforeAll, describe, expect, it } from 'vitest'
import {
  findCall,
  publishedBy,
  publishedFieldPaths,
  runOrchestrationSkewJourney,
  type OrchestrationSkewRecord
} from './orchestration-skew-journey'
import { comparePublishedFields } from './published-field-shape'
import { resolveBaselineReleaseRefs } from './release-checkout'
import {
  loadOrchestrationWireBuild,
  WORKING_TREE,
  type OrchestrationWireBuild
} from './versioned-orchestration-wire'

// Why: a cold CI run extracts two release checkouts before the first pairing.
const SUITE_TIMEOUT_MS = 300_000

/** A desktop pinned at the prior release is a normal federation peer for weeks. */
const BASELINE_COUNT = 2

const ATTACH = 'orchestration.federationAttachStart'
const FLEET_SNAPSHOT = 'orchestration.federationFleetSnapshot'
const SHOW = 'orchestration.federationShow'
const READ = 'orchestration.federationRead'
const PULL = 'orchestration.federationPull'
const IMPORT = 'orchestration.federationImport'

/** Every method whose published payload a coordinator decodes on this journey. */
const PUBLISHED_METHODS = [ATTACH, SHOW, READ, PULL, IMPORT, FLEET_SNAPSHOT]

/**
 * Runtime seams the RPC dispatcher touches on every method, federated or not:
 * client-hosted browser routing and feature telemetry. They are named here so any
 * *other* gap in the host stub fails loudly instead of returning undefined and
 * reading as a wire break.
 */
const DISPATCHER_PLUMBING = new Set(['routeClientHostedBrowserRpc', 'recordFeatureInteraction'])

type BaselinePairings = {
  ref: string
  build: OrchestrationWireBuild
  /** Old coordinator against the working tree host. */
  oldClient: OrchestrationSkewRecord
  /** Working tree coordinator against the old host. */
  oldHost: OrchestrationSkewRecord
  /** The old build talking to itself: what that release publishes today. */
  reference: OrchestrationSkewRecord
}

// Resolved at collection time so each baseline gets its own named describe block;
// a lane that quietly ran one pairing instead of two is the failure to avoid.
const BASELINE_REFS = resolveBaselineReleaseRefs(BASELINE_COUNT)

let current: OrchestrationWireBuild
let currentReference: OrchestrationSkewRecord
const pairings = new Map<string, BaselinePairings>()

function pairingFor(ref: string): BaselinePairings {
  const pairing = pairings.get(ref)
  if (!pairing) {
    throw new Error(`Cross-version orchestration pairing for ${ref} was never built`)
  }
  return pairing
}

beforeAll(async () => {
  current = await loadOrchestrationWireBuild(WORKING_TREE)
  currentReference = await runOrchestrationSkewJourney({
    clientBuild: current,
    hostBuild: current
  })
  for (const ref of BASELINE_REFS) {
    const build = await loadOrchestrationWireBuild(ref)
    pairings.set(ref, {
      ref,
      build,
      oldClient: await runOrchestrationSkewJourney({ clientBuild: build, hostBuild: current }),
      oldHost: await runOrchestrationSkewJourney({ clientBuild: current, hostBuild: build }),
      reference: await runOrchestrationSkewJourney({ clientBuild: build, hostBuild: build })
    })
  }
}, SUITE_TIMEOUT_MS)

function orchestrationMethods(build: OrchestrationWireBuild): string[] {
  return build.methodNames.filter((name) => name.startsWith('orchestration.'))
}

function describeRecord(record: OrchestrationSkewRecord): string {
  return `${record.clientLabel} coordinator -> ${record.hostLabel} host`
}

function stallDetail(record: OrchestrationSkewRecord): string {
  return JSON.stringify({ completed: record.completed, stepErrors: record.stepErrors })
}

describe('cross-version orchestration federation wire', () => {
  it(
    'skews current code against two real published releases',
    () => {
      expect(BASELINE_REFS.length).toBe(BASELINE_COUNT)
      expect(new Set(BASELINE_REFS).size).toBe(BASELINE_COUNT)
      for (const pairing of pairings.values()) {
        expect(pairing.build.revision).toMatch(/^[0-9a-f]{40}$/)
        expect(pairing.build.revision).not.toBe(current.revision)
        // Anti-vacuous: an empty registry would make every "this release does not
        // register X" claim below meaningless.
        expect(pairing.build.methodNames).toContain('terminal.create')
        expect(orchestrationMethods(pairing.build).length).toBeGreaterThan(0)
      }
      expect(new Set([...pairings.values()].map((entry) => entry.build.revision)).size).toBe(
        BASELINE_COUNT
      )
    },
    SUITE_TIMEOUT_MS
  )

  it('reaches the whole journey when both sides are current code', () => {
    expect(currentReference.stepErrors, stallDetail(currentReference)).toEqual([])
    expect(currentReference.completed).toEqual([
      'attach-start',
      'fleet-snapshot',
      'worker-show',
      'worker-read',
      'relay-sync'
    ])
  })

  it('keeps one orchestration contract version across every paired build', () => {
    // A bump fences every peer that has not updated, on every orchestration
    // mutation at once. That is a deliberate flag day, never a side effect.
    for (const pairing of pairings.values()) {
      expect(
        pairing.build.orchestrationContractVersion,
        `${pairing.ref} would be fenced out of every orchestration mutation`
      ).toBe(current.orchestrationContractVersion)
    }
  })

  describe.each(BASELINE_REFS)('against %s', (ref) => {
    it('never drops an orchestration method name a released peer may still call', () => {
      const pairing = pairingFor(ref)
      // A renamed or removed verb is Rule 3 for an `orca` CLI or coordinator that
      // has not updated: it calls the old name and gets method_not_found.
      const removed = orchestrationMethods(pairing.build).filter(
        (name) => !current.methodNames.includes(name)
      )
      expect(removed, `${pairing.ref} registers methods current code dropped`).toEqual([])
    })

    it('registers the attach method on both sides rather than skipping the pairing', () => {
      const pairing = pairingFor(ref)
      // A supported peer without the attach method is the bug, not a reason to skip:
      // the coordinator would have nothing to degrade to.
      expect(pairing.build.methodNames).toContain(ATTACH)
      expect(current.methodNames).toContain(ATTACH)
    })

    it('starts a federated worker from the old coordinator against the new host', () => {
      const pairing = pairingFor(ref)
      const record = pairing.oldClient
      const attach = findCall(record, ATTACH)
      expect(attach, `${describeRecord(record)} never called ${ATTACH}`).toBeDefined()
      expect(
        attach?.error,
        `${describeRecord(record)} was refused: ${JSON.stringify(attach?.error)}`
      ).toBeNull()
      expect(record.startReceipt?.state, stallDetail(record)).toBe('ready')
      expect(record.completed).toContain('attach-start')
      // The host must bind the attachment to a Run whatever the coordinator sent,
      // or every later control-mail import fails its `requireRun`.
      expect(record.hostHomeRunId, 'the new host bound no home Run').toBeTruthy()
    })

    it('starts a federated worker from the new coordinator against the old host', () => {
      const pairing = pairingFor(ref)
      const record = pairing.oldHost
      const attach = findCall(record, ATTACH)
      expect(
        attach?.error,
        `${describeRecord(record)} was refused: ${JSON.stringify(attach?.error)}`
      ).toBeNull()
      expect(record.startReceipt?.state, stallDetail(record)).toBe('ready')
    })

    it('has each build accept the other build’s outgoing attach params', () => {
      const pairing = pairingFor(ref)
      // Read from what the builds really sent, so neither side's required-field
      // list is written down here.
      const fromOld = findCall(pairing.oldClient, ATTACH)?.params
      const fromNew = findCall(pairing.oldHost, ATTACH)?.params
      expect(fromOld).toBeTruthy()
      expect(fromNew).toBeTruthy()
      expect(() => current.parseAttachStartParams(fromOld)).not.toThrow()
      expect(() => pairing.build.parseAttachStartParams(fromNew)).not.toThrow()
    })

    it.each(PUBLISHED_METHODS)('still publishes every %s field the old peer reads', (method) => {
      const pairing = pairingFor(ref)
      // Rule 3, both sides read from a pairing rather than from a list: what the
      // release publishes to a coordinator of its own version, against what current
      // code publishes to a coordinator of its own version.
      const older = publishedBy(pairing.reference, method)
      const newer = publishedBy(currentReference, method)
      if (Object.keys(older).length === 0) {
        // The release never published this method at all; its absence is covered
        // by the degradation test below, not by a field comparison.
        expect(findCall(pairing.reference, method)?.result ?? null).toBeNull()
        return
      }
      expect(Object.keys(newer).length, `current code published no ${method}`).toBeGreaterThan(0)
      const skew = comparePublishedFields({
        older: publishedFieldPaths(older),
        newer: publishedFieldPaths(newer)
      })
      expect(skew.removed, `${method} dropped fields a ${pairing.ref} peer reads`).toEqual([])
    })

    it('degrades instead of throwing when the old host has no fleet snapshot', () => {
      const pairing = pairingFor(ref)
      const record = pairing.oldHost
      const hostHasMethod = pairing.build.methodNames.includes(FLEET_SNAPSHOT)
      expect(record.fleet, stallDetail(record)).not.toBeNull()
      if (hostHasMethod) {
        expect(record.fleet?.errorCodes).toEqual([])
        expect(Object.keys(record.fleet?.observations ?? {}).length).toBe(1)
        return
      }
      // The coordinator must turn a missing method into a named degradation, not a
      // thrown call and not a fabricated verdict.
      expect(record.fleet?.errorCodes).toEqual(['capability_unsupported'])
      expect(record.fleet?.observations).toEqual({})
      expect(record.completed).toContain('fleet-snapshot')
    })

    it('reads and shows the worker across the skew in both directions', () => {
      const pairing = pairingFor(ref)
      for (const record of [pairing.oldClient, pairing.oldHost]) {
        expect(record.completed, `${describeRecord(record)}: ${stallDetail(record)}`).toContain(
          'worker-show'
        )
        expect(record.completed, `${describeRecord(record)}: ${stallDetail(record)}`).toContain(
          'worker-read'
        )
      }
    })

    it('relays mail both ways across the skew', () => {
      const pairing = pairingFor(ref)
      for (const record of [pairing.oldClient, pairing.oldHost]) {
        expect(record.completed, `${describeRecord(record)}: ${stallDetail(record)}`).toContain(
          'relay-sync'
        )
        // The worker's report was pulled and acknowledged...
        expect(record.syncResult, describeRecord(record)).toMatchObject({
          imported: 1,
          acknowledgedThrough: 1
        })
        // ...and the coordinator's control mail reached the worker's mailbox,
        // which the host can only do once it resolves the attachment's home Run.
        expect(
          record.controlMailImported,
          `${describeRecord(record)} imported no coordinator control mail`
        ).toBe(1)
      }
    })

    it('exercises the whole federation surface rather than a stubbed-out one', () => {
      const pairing = pairingFor(ref)
      for (const record of [pairing.oldClient, pairing.oldHost, pairing.reference]) {
        const gaps = [
          ...record.missingHostRuntimeMethods,
          ...record.missingClientRuntimeMethods
        ].filter((name) => !DISPATCHER_PLUMBING.has(name))
        expect(gaps, `${describeRecord(record)} needed unstubbed runtime methods`).toEqual([])
      }
    })

    it('only ever loses a step the old build genuinely cannot take', () => {
      const pairing = pairingFor(ref)
      // A coordinator that predates a caller cannot make that call; anything else
      // failing is a skew break rather than a version fact.
      const clientHasFleetCaller = pairing.build.readFederatedFleetSnapshots !== null
      const expectedOldClientSteps = clientHasFleetCaller
        ? currentReference.completed
        : currentReference.completed.filter((step) => step !== 'fleet-snapshot')
      expect(pairing.oldClient.completed, stallDetail(pairing.oldClient)).toEqual(
        expectedOldClientSteps
      )
      expect(pairing.oldHost.completed, stallDetail(pairing.oldHost)).toEqual(
        currentReference.completed
      )
    })
  })
})
