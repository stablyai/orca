import type { OrchestrationWireBuild, RpcEnvelope } from './versioned-orchestration-wire'

/**
 * The two ends of a federation pairing, each built from one release.
 *
 * The host is that build's real RPC dispatcher over that build's real orchestration
 * store; the Run home is that build's real coordinator-side callers whose
 * `callOrchestrationWorkerServer` forwards to the peer's dispatcher over a JSON
 * round trip. Nothing between them is hand-written, so a pairing fails on what
 * those builds really send and publish.
 */

export const FEDERATION_FIXTURES = {
  environmentId: 'environment_worker_host',
  environmentName: 'worker-host',
  hostPeerFingerprint: 'worker_host_peer_fingerprint',
  homePeerFingerprint: 'run_home_peer_fingerprint',
  worktreeSelector: 'id:repo::remote-worktree',
  worktreeId: 'repo::remote-worktree',
  workerTerminal: 'term_remote_worker',
  coordinatorTerminal: 'term_coord',
  coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workerPaneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workerIncarnation: 'worker_host_epoch:pty:1',
  taskSpec: 'Cross-version federation journey'
} as const

export type WireCall = {
  method: string
  /** Params exactly as they left the coordinator, after the JSON round trip. */
  params: Record<string, unknown> | null
  /** Result exactly as the host published it, or null when the call was refused. */
  result: unknown
  error: { code: string; message: string } | null
}

export type OrchestrationStoreHandle = ReturnType<OrchestrationWireBuild['createStore']>

export type FederationHostPeer = {
  store: OrchestrationStoreHandle
  runtime: unknown
  missing: string[]
  call: (
    method: string,
    params: unknown,
    envelope: { requestId?: string; contractVersion?: number }
  ) => Promise<RpcEnvelope>
}

export type FederationHomePeer = {
  store: OrchestrationStoreHandle
  runtime: unknown
  missing: string[]
  runId: string
  taskId: string
}

/** Record every method a build asked for that the stub lacks, by name, so a gap
 *  fails naming what to add here instead of as a TypeError that reads like a break. */
function stubRuntime(methods: Record<string, unknown>): { runtime: unknown; missing: string[] } {
  const missing: string[] = []
  const runtime = new Proxy(methods, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        if (!missing.includes(property)) {
          missing.push(property)
        }
        return () => undefined
      }
      return Reflect.get(target, property, receiver)
    }
  })
  return { runtime, missing }
}

export function storeCall<T>(
  store: OrchestrationStoreHandle,
  method: string,
  ...args: unknown[]
): T {
  const fn = store[method]
  if (typeof fn !== 'function') {
    throw new Error(`Orchestration store has no ${method}; the journey needs updating.`)
  }
  return (fn as (...rest: unknown[]) => T).apply(store, args)
}

/** The worker host: this build's real dispatcher over this build's real store. */
export function createFederationHostPeer(build: OrchestrationWireBuild): FederationHostPeer {
  const store = build.createStore()
  const terminal = {
    handle: FEDERATION_FIXTURES.workerTerminal,
    worktreeId: FEDERATION_FIXTURES.worktreeId,
    status: 'running',
    connected: true
  }
  const { runtime, missing } = stubRuntime({
    getRuntimeId: () => `worker_host_epoch:${build.label}`,
    // Capabilities come from the host build's own source, so a coordinator's
    // negotiation sees what that release could really advertise.
    getStatus: () => ({
      runtimeId: `worker_host_epoch:${build.label}`,
      protocolVersion: build.protocolVersion,
      capabilities: build.capabilities
    }),
    getOrchestrationDb: () => store,
    getNestedWorkerMaxDepth: () => 3,
    validateOrchestrationAgentLauncher: () => {},
    showManagedTerminalWorkspace: async () => ({
      id: FEDERATION_FIXTURES.worktreeId,
      repoId: 'repo'
    }),
    showTerminal: async () => terminal,
    isTerminalRunningAgent: async () => true,
    listTerminals: async () => ({ terminals: [terminal], totalCount: 1, truncated: false }),
    waitForTerminal: async () => ({
      handle: FEDERATION_FIXTURES.workerTerminal,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }),
    getOrchestrationDispatchAuthority: () => ({
      paneKey: FEDERATION_FIXTURES.workerPaneKey,
      processIncarnation: FEDERATION_FIXTURES.workerIncarnation,
      hostScope: { kind: 'local' }
    }),
    getTerminalPaneKey: () => FEDERATION_FIXTURES.workerPaneKey,
    getTerminalProcessIncarnation: () => FEDERATION_FIXTURES.workerIncarnation,
    getTerminalLivenessVerdict: () => ({
      status: 'live',
      ptyIds: [FEDERATION_FIXTURES.workerTerminal]
    }),
    getTerminalOrchestrationCliCommand: () => 'orca',
    sendTerminalAgentPrompt: async () => ({
      handle: FEDERATION_FIXTURES.workerTerminal,
      accepted: true,
      bytesWritten: 1
    }),
    readTerminal: async () => ({
      handle: FEDERATION_FIXTURES.workerTerminal,
      status: 'running',
      entries: [{ cursor: 1, text: 'remote worker output' }],
      nextCursor: '1',
      limited: false
    }),
    notifyMessageArrived: () => {}
  })
  const dispatcher = build.createDispatcher(runtime)
  return {
    store,
    runtime,
    missing,
    call: (method, params, envelope) =>
      dispatcher.dispatch(
        {
          id: `${build.label}-${method}`,
          method,
          params,
          ...(envelope.requestId ? { orchestrationRequestId: envelope.requestId } : {}),
          ...(envelope.contractVersion === undefined
            ? {}
            : { orchestrationContractVersion: envelope.contractVersion })
        },
        { authenticatedCallerFingerprint: FEDERATION_FIXTURES.homePeerFingerprint }
      )
  }
}

/** The Run home: this build's coordinator-side callers over its own store. */
export function createFederationHomePeer(
  build: OrchestrationWireBuild,
  host: FederationHostPeer,
  calls: WireCall[]
): FederationHomePeer {
  const store = build.createStore()
  const run = storeCall<{ id: string }>(store, 'createRun', {
    objective: FEDERATION_FIXTURES.taskSpec,
    coordinatorHandle: FEDERATION_FIXTURES.coordinatorTerminal,
    coordinatorPaneKey: FEDERATION_FIXTURES.coordinatorPaneKey
  })
  const task = storeCall<{ id: string }>(store, 'createTask', {
    spec: FEDERATION_FIXTURES.taskSpec,
    runId: run.id,
    createdByTerminalHandle: FEDERATION_FIXTURES.coordinatorTerminal,
    createdByPaneKey: FEDERATION_FIXTURES.coordinatorPaneKey
  })
  const { runtime, missing } = stubRuntime({
    getRuntimeId: () => `run_home_epoch:${build.label}`,
    getOrchestrationDb: () => store,
    getNestedWorkerMaxDepth: () => 3,
    validateOrchestrationAgentLauncher: () => {},
    resolveOrchestrationWorkerServer: () => ({
      environmentId: FEDERATION_FIXTURES.environmentId,
      name: FEDERATION_FIXTURES.environmentName,
      peerFingerprint: FEDERATION_FIXTURES.hostPeerFingerprint,
      pairingRevision: 1
    }),
    getOrchestrationDispatchAuthority: () => ({
      paneKey: FEDERATION_FIXTURES.coordinatorPaneKey,
      processIncarnation: 'run_home_epoch:pty:1'
    }),
    getTerminalPaneKey: () => FEDERATION_FIXTURES.coordinatorPaneKey,
    getTerminalProcessIncarnation: () => 'run_home_epoch:pty:1',
    ensureOrchestrationFederationRelay: () => {},
    stopOrchestrationFederationRelay: () => {},
    syncOrchestrationFederatedDispatchAfterCurrent: async () => undefined,
    notifyMessageArrived: () => {},
    callOrchestrationWorkerServer: async (
      _environmentId: string,
      method: string,
      params: unknown,
      _timeoutMs?: number,
      meta?: { orchestrationRequestId?: string }
    ) => {
      // The wire, exactly: an `undefined` field never reaches the far side.
      const wireParams =
        params === undefined ? undefined : (JSON.parse(JSON.stringify(params)) as unknown)
      const reply = await host.call(method, wireParams, {
        requestId: meta?.orchestrationRequestId,
        // The transport stamps the coordinator build's own contract version on
        // every orchestration call; the host fences anything it does not know.
        ...(method.startsWith('orchestration.')
          ? { contractVersion: build.orchestrationContractVersion }
          : {})
      })
      const entry: WireCall = {
        method,
        params: (wireParams as Record<string, unknown> | undefined) ?? null,
        result: reply.ok ? (reply.result ?? null) : null,
        error: reply.ok ? null : (reply.error ?? { code: 'unknown', message: 'no error payload' })
      }
      calls.push(entry)
      if (!reply.ok) {
        throw build.createRpcError(
          entry.error?.code ?? 'unknown',
          entry.error?.message ?? 'The worker server refused the call.'
        )
      }
      return reply.result
    }
  })
  return { store, runtime, missing, runId: run.id, taskId: task.id }
}
