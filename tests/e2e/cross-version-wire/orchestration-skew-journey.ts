import {
  createFederationHomePeer,
  createFederationHostPeer,
  FEDERATION_FIXTURES,
  storeCall,
  type WireCall
} from './orchestration-federation-peers'
import type { OrchestrationWireBuild } from './versioned-orchestration-wire'

/**
 * One scripted federation journey, run byte-identically for every coordinator/host
 * version pairing: a coordinator starts a remote worker, watches the fleet, reads
 * and shows it, and relays mail both ways.
 *
 * Every step ends on a recorded fact — a wire call, a persisted row, a receipt the
 * coordinator's own parser accepted — never on elapsed time.
 */

export const JOURNEY_STEPS = [
  'attach-start',
  'fleet-snapshot',
  'worker-show',
  'worker-read',
  'relay-sync'
] as const

export type JourneyStep = (typeof JOURNEY_STEPS)[number]

const WORKER_REPORT_SUBJECT = 'worker status'
const CONTROL_MAIL_SUBJECT = 'coordinator control mail'
const READINESS_TIMEOUT_MS = 60_000

export type OrchestrationSkewRecord = {
  clientLabel: string
  hostLabel: string
  clientRevision: string
  hostRevision: string
  /** Steps that actually completed, in order. The liveness oracle. */
  completed: JourneyStep[]
  /** Every request/response pair the journey put on the wire, in order. */
  calls: WireCall[]
  /** What `startFederatedWorker` handed back to the coordinator. */
  startReceipt: Record<string, unknown> | null
  /** Fleet verdicts the coordinator derived, and the host errors it degraded to. */
  fleet: {
    observations: Record<string, unknown>
    errorCodes: string[]
  } | null
  /** The Run the host bound the attachment to. A coordinator that sends none still
   *  needs one here, or every later control-mail import fails `requireRun`. */
  hostHomeRunId: string | null
  /** How many relay items the host reported importing from the coordinator. */
  controlMailImported: number
  syncResult: { imported: number; acknowledgedThrough: number } | null
  missingHostRuntimeMethods: string[]
  missingClientRuntimeMethods: string[]
  stepErrors: { step: JourneyStep; message: string }[]
}

/** A pairing that never advanced past a step, carrying the partial record. */
export class OrchestrationSkewStall extends Error {
  readonly step: JourneyStep
  readonly record: OrchestrationSkewRecord

  constructor(step: JourneyStep, detail: string, record: OrchestrationSkewRecord) {
    super(`Cross-version orchestration journey stalled at ${step}: ${detail}`)
    this.name = 'OrchestrationSkewStall'
    this.step = step
    this.record = record
  }
}

function published(call: WireCall | undefined): Record<string, unknown> {
  const result = call?.result
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {}
}

export function findCall(record: OrchestrationSkewRecord, method: string): WireCall | undefined {
  return record.calls.find((call) => call.method === method)
}

export function publishedBy(
  record: OrchestrationSkewRecord,
  method: string
): Record<string, unknown> {
  return published(findCall(record, method))
}

/**
 * Dotted names for every field in a published payload, nested objects included.
 *
 * A federation receipt carries fields a coordinator reads inside `setup`, `launch`,
 * `attachment` and `observation`; comparing only the top level would let a removal
 * one level down pass. Arrays are walked through their first element, because every
 * item in these payloads is the same shape.
 */
export function publishedFieldPaths(payload: unknown, prefix = ''): string[] {
  if (Array.isArray(payload)) {
    return payload.length === 0 ? [] : publishedFieldPaths(payload[0], `${prefix}[]`)
  }
  if (!payload || typeof payload !== 'object') {
    return prefix ? [prefix] : []
  }
  return Object.entries(payload as Record<string, unknown>)
    .flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key
      const nested = publishedFieldPaths(value, path)
      return nested.length === 0 ? [path] : nested
    })
    .sort()
}

/**
 * Drive one federation journey for a coordinator build against a host build.
 *
 * Steps a build genuinely cannot take — a coordinator with no fleet-snapshot caller,
 * a host with no such method — are recorded rather than thrown, so the suite can
 * assert the degradation instead of losing the rest of the journey.
 */
export async function runOrchestrationSkewJourney(args: {
  clientBuild: OrchestrationWireBuild
  hostBuild: OrchestrationWireBuild
}): Promise<OrchestrationSkewRecord> {
  const { clientBuild, hostBuild } = args
  const calls: WireCall[] = []
  const host = createFederationHostPeer(hostBuild)
  const client = createFederationHomePeer(clientBuild, host, calls)
  const record: OrchestrationSkewRecord = {
    clientLabel: clientBuild.label,
    hostLabel: hostBuild.label,
    clientRevision: clientBuild.revision,
    hostRevision: hostBuild.revision,
    completed: [],
    calls,
    startReceipt: null,
    fleet: null,
    hostHomeRunId: null,
    controlMailImported: 0,
    syncResult: null,
    missingHostRuntimeMethods: host.missing,
    missingClientRuntimeMethods: client.missing,
    stepErrors: []
  }

  const step = async (name: JourneyStep, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
      record.completed.push(name)
    } catch (error) {
      record.stepErrors.push({
        step: name,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  try {
    // 1. worker-start against a federated target. The coordinator build composes
    //    every attach param itself; the host validates with its own schema.
    const receipt = (await clientBuild.startFederatedWorker({
      params: {
        on: FEDERATION_FIXTURES.environmentId,
        worktree: FEDERATION_FIXTURES.worktreeSelector,
        terminal: FEDERATION_FIXTURES.workerTerminal,
        spec: FEDERATION_FIXTURES.taskSpec,
        from: FEDERATION_FIXTURES.coordinatorTerminal,
        timeoutMs: READINESS_TIMEOUT_MS
      },
      runtime: client.runtime,
      db: client.store,
      runId: client.runId,
      task: { id: client.taskId, spec: FEDERATION_FIXTURES.taskSpec, status: 'pending' },
      orchestrationMutation: {
        callerFingerprint: FEDERATION_FIXTURES.homePeerFingerprint,
        requestId: `attach_${clientBuild.label}_${hostBuild.label}`,
        method: 'orchestration.workerStart',
        payloadHash: 'cross_version_attach_payload'
      }
    })) as Record<string, unknown>
    record.startReceipt = receipt
    const attach = findCall(record, 'orchestration.federationAttachStart')
    if (!attach) {
      throw new OrchestrationSkewStall(
        'attach-start',
        'the coordinator never called orchestration.federationAttachStart',
        record
      )
    }
    if (attach.error) {
      record.stepErrors.push({
        step: 'attach-start',
        message: `${attach.error.code}: ${attach.error.message}`
      })
    } else {
      record.completed.push('attach-start')
    }
    const dispatchId = String(receipt.dispatchId ?? '')
    if (!dispatchId) {
      return record
    }
    record.hostHomeRunId =
      storeCall<{ home_run_id?: string } | undefined>(
        host.store,
        'getRemoteDispatchAttachment',
        dispatchId
      )?.home_run_id ?? null
    const federated = storeCall<Record<string, unknown> | undefined>(
      client.store,
      'getFederatedDispatch',
      dispatchId
    )
    if (!federated) {
      return record
    }

    // 2. The fleet sweep the coordinator runs behind `worker-list`.
    await step('fleet-snapshot', async () => {
      const read = clientBuild.readFederatedFleetSnapshots
      if (!read) {
        throw new Error(`${clientBuild.label} has no fleet-snapshot caller`)
      }
      const snapshot = await read({
        runtime: client.runtime,
        db: client.store,
        dispatchIds: [dispatchId]
      })
      record.fleet = {
        observations: Object.fromEntries(snapshot.observations),
        errorCodes: snapshot.errors.map((error) => error.code).sort()
      }
    })

    // 3/4. The read paths behind `worker-show` and `worker-read --include-remote`.
    await step('worker-show', async () => {
      await clientBuild.callFederatedWorkerShow(client.runtime, federated)
    })
    await step('worker-read', async () => {
      await clientBuild.readLegacyFederatedTerminal({
        runtime: client.runtime,
        server: {
          environmentId: FEDERATION_FIXTURES.environmentId,
          name: FEDERATION_FIXTURES.environmentName,
          peerFingerprint: FEDERATION_FIXTURES.hostPeerFingerprint,
          pairingRevision: 1
        },
        federated,
        workerState: 'ready',
        dispatchId,
        source: undefined,
        cursor: undefined,
        limit: 10
      })
    })

    // 5. Mail both ways over the relay: the worker's report is pulled and
    //    acknowledged, and the coordinator's control mail is imported.
    await step('relay-sync', async () => {
      storeCall(host.store, 'enqueueFederationRelay', {
        dispatchId,
        direction: 'to_home',
        kind: 'message',
        payload: JSON.stringify({
          from: `dispatch:${dispatchId}`,
          subject: WORKER_REPORT_SUBJECT,
          body: 'halfway through',
          type: 'status',
          priority: 'normal'
        })
      })
      storeCall(client.store, 'enqueueFederationRelay', {
        dispatchId,
        direction: 'to_worker',
        kind: 'control_message',
        payload: clientBuild.encodeControlMessage({
          from: `run:${client.runId}`,
          subject: CONTROL_MAIL_SUBJECT,
          body: 'keep going',
          type: 'status',
          priority: 'normal',
          threadId: null,
          payload: null
        })
      })
      record.syncResult = (await clientBuild.syncFederatedDispatch(
        client.runtime,
        dispatchId
      )) as OrchestrationSkewRecord['syncResult']
      const imported = publishedBy(record, 'orchestration.federationImport').imported
      record.controlMailImported = typeof imported === 'number' ? imported : 0
    })
  } finally {
    host.store.close()
    client.store.close()
  }

  return record
}
