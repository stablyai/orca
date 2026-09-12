import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  type ReleaseCheckout
} from './release-checkout'

/**
 * One build's orchestration federation surface: the host dispatcher it registers,
 * the coordinator-side callers that compose what goes on the wire, and the store
 * both sides persist into. Everything here is read from the build, so "this
 * release does not have X" is a fact about a real checkout rather than a list.
 */

export const WORKING_TREE = 'working-tree' as const

/** Modules whose path moved when orchestration RPC methods were foldered. */
const MODULE_ALIASES = {
  dispatcher: ['/src/main/runtime/rpc/dispatcher.ts'],
  methodRegistry: ['/src/main/runtime/rpc/methods/index.ts'],
  protocol: ['/src/shared/protocol-version.ts'],
  db: ['/src/main/runtime/orchestration/db.ts'],
  orchestrationError: ['/src/main/runtime/orchestration/orchestration-error.ts'],
  federationSync: ['/src/main/runtime/orchestration/federation-sync.ts'],
  controlMessage: ['/src/main/runtime/orchestration/federation-control-message.ts'],
  federatedWorkerStart: [
    '/src/main/runtime/rpc/methods/orchestration/federation/federated-worker-start.ts',
    '/src/main/runtime/rpc/methods/orchestration-federated-worker-start.ts'
  ],
  workerObservation: [
    '/src/main/runtime/rpc/methods/orchestration/worker/worker-observation.ts',
    '/src/main/runtime/rpc/methods/orchestration-worker-observation.ts'
  ],
  legacyFederatedRead: [
    '/src/main/runtime/rpc/methods/orchestration/worker/worker-legacy-federated-read.ts',
    '/src/main/runtime/rpc/methods/orchestration-worker-legacy-federated-read.ts'
  ],
  attachStartSchema: [
    '/src/main/runtime/rpc/methods/orchestration/federation/federation-start-schema.ts',
    '/src/main/runtime/rpc/methods/orchestration-federation-start-schema.ts'
  ],
  /** Absent from builds that predate the fleet snapshot; absence is the finding. */
  fleetSnapshot: [
    '/src/main/runtime/rpc/methods/orchestration/federation/federated-fleet-snapshot.ts',
    '/src/main/runtime/rpc/methods/orchestration-federated-fleet-snapshot.ts'
  ]
} as const

type ModuleKey = keyof typeof MODULE_ALIASES

export type RpcEnvelope = {
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export type OrchestrationDispatcher = {
  dispatch: (
    request: {
      id: string
      method: string
      params?: unknown
      orchestrationRequestId?: string
      orchestrationContractVersion?: number
    },
    options?: { authenticatedCallerFingerprint?: string }
  ) => Promise<RpcEnvelope>
}

export type OrchestrationStore = {
  close: () => void
  [method: string]: unknown
}

export type OrchestrationWireBuild = {
  /** Human label used in test names and failure messages. */
  label: string
  /** `working-tree` for current code, otherwise the resolved release commit. */
  revision: string
  /** Capability strings this build defines; a host cannot advertise more. */
  capabilities: readonly string[]
  protocolVersion: number
  /** Stamped on every outgoing `orchestration.*` call; a host fences a mismatch. */
  orchestrationContractVersion: number
  /** Every RPC method name this build registers, read from its own registry. */
  methodNames: readonly string[]
  /** A dispatcher over the method set this build really ships. */
  createDispatcher: (runtime: unknown) => OrchestrationDispatcher
  /** In-memory store of this build's schema, migrated by this build's code. */
  createStore: () => OrchestrationStore
  /** This build's error class, so a peer's `instanceof` narrowing still fires. */
  createRpcError: (code: string, message: string) => Error
  /** Coordinator-side composer of `orchestration.federationAttachStart` params. */
  startFederatedWorker: (args: Record<string, unknown>) => Promise<unknown>
  /** Coordinator-side caller of `orchestration.federationShow`. */
  callFederatedWorkerShow: (runtime: unknown, federated: unknown) => Promise<unknown>
  /** Coordinator-side caller of `orchestration.federationRead`. */
  readLegacyFederatedTerminal: (args: Record<string, unknown>) => Promise<unknown>
  /** Coordinator-side pull/ack/import loop. */
  syncFederatedDispatch: (runtime: unknown, dispatchId: string) => Promise<unknown>
  encodeControlMessage: (message: Record<string, unknown>) => string
  /** The host-side zod schema for attach params, used to cross-validate a peer's send. */
  parseAttachStartParams: (params: unknown) => unknown
  /** null when this build has no fleet-snapshot caller at all. */
  readFederatedFleetSnapshots:
    | ((args: Record<string, unknown>) => Promise<{
        observations: Map<string, Record<string, unknown>>
        errors: { code: string; dispatchIds: string[] }[]
      }>)
    | null
}

function registeredMethodNames(methods: readonly unknown[]): string[] {
  return methods
    .flatMap((method) => {
      if (!method || typeof method !== 'object') {
        return []
      }
      const name = Reflect.get(method, 'name')
      return typeof name === 'string' ? [name] : []
    })
    .sort()
}

function pick<T>(module: Record<string, unknown>, name: string, label: string): T {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`Build ${label} publishes no ${name}; the federation surface moved.`)
  }
  return value as T
}

type ModuleLoader = (key: ModuleKey) => Promise<Record<string, unknown> | null>

async function assembleBuild(args: {
  label: string
  revision: string
  load: ModuleLoader
}): Promise<OrchestrationWireBuild> {
  const { label, revision, load } = args
  const required = async (key: ModuleKey): Promise<Record<string, unknown>> => {
    const module = await load(key)
    if (!module) {
      throw new Error(
        `Build ${label} has no module for ${key}; add its path to MODULE_ALIASES rather than skipping the pairing.`
      )
    }
    return module
  }
  const [
    protocol,
    dispatcher,
    methodRegistry,
    store,
    errors,
    sync,
    controlMessage,
    workerStart,
    observation,
    legacyRead,
    schema,
    fleet
  ] = await Promise.all([
    required('protocol'),
    required('dispatcher'),
    required('methodRegistry'),
    required('db'),
    required('orchestrationError'),
    required('federationSync'),
    required('controlMessage'),
    required('federatedWorkerStart'),
    required('workerObservation'),
    required('legacyFederatedRead'),
    required('attachStartSchema'),
    load('fleetSnapshot')
  ])

  const capabilities = protocol.RUNTIME_CAPABILITIES
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error(`Build ${label} declares no RUNTIME_CAPABILITIES to negotiate with`)
  }
  const RpcDispatcher = pick<
    new (options: { runtime: unknown; methods: unknown[] }) => OrchestrationDispatcher
  >(dispatcher, 'RpcDispatcher', label)
  const Store = pick<new (path: string) => OrchestrationStore>(store, 'OrchestrationDb', label)
  const RpcError = pick<new (code: string, message: string) => Error>(
    errors,
    'OrchestrationError',
    label
  )
  const attachSchema = schema.FederationAttachStartParams as { parse: (value: unknown) => unknown }
  if (typeof attachSchema?.parse !== 'function') {
    throw new Error(`Build ${label} publishes no FederationAttachStartParams schema`)
  }
  const methods = methodRegistry.ALL_RPC_METHODS as unknown[]

  return {
    label,
    revision,
    capabilities: capabilities as readonly string[],
    protocolVersion: protocol.RUNTIME_PROTOCOL_VERSION as number,
    orchestrationContractVersion: protocol.ORCHESTRATION_CONTRACT_VERSION as number,
    methodNames: registeredMethodNames(methods),
    createDispatcher: (runtime) => new RpcDispatcher({ runtime, methods }),
    createStore: () => new Store(':memory:'),
    createRpcError: (code, message) => new RpcError(code, message),
    startFederatedWorker: pick(workerStart, 'startFederatedWorker', label),
    callFederatedWorkerShow: pick(observation, 'callFederatedWorkerShow', label),
    readLegacyFederatedTerminal: pick(legacyRead, 'readLegacyFederatedTerminal', label),
    syncFederatedDispatch: pick(sync, 'syncFederatedDispatch', label),
    encodeControlMessage: pick(controlMessage, 'encodeFederatedControlMessage', label),
    parseAttachStartParams: (params) => attachSchema.parse(params),
    readFederatedFleetSnapshots: fleet ? pick(fleet, 'readFederatedFleetSnapshots', label) : null
  }
}

function workingTreeLoader(): ModuleLoader {
  // Static specifiers so the working tree is compiled by the test runner's own
  // module graph; a dynamic path here would resolve against the checkout cache.
  const modules: Record<ModuleKey, () => Promise<Record<string, unknown>>> = {
    protocol: () => import('../../../src/shared/protocol-version'),
    dispatcher: () => import('../../../src/main/runtime/rpc/dispatcher'),
    methodRegistry: () => import('../../../src/main/runtime/rpc/methods'),
    db: () => import('../../../src/main/runtime/orchestration/db'),
    orchestrationError: () => import('../../../src/main/runtime/orchestration/orchestration-error'),
    federationSync: () => import('../../../src/main/runtime/orchestration/federation-sync'),
    controlMessage: () =>
      import('../../../src/main/runtime/orchestration/federation-control-message'),
    federatedWorkerStart: () =>
      import('../../../src/main/runtime/rpc/methods/orchestration/federation/federated-worker-start'),
    workerObservation: () =>
      import('../../../src/main/runtime/rpc/methods/orchestration/worker/worker-observation'),
    legacyFederatedRead: () =>
      import('../../../src/main/runtime/rpc/methods/orchestration/worker/worker-legacy-federated-read'),
    attachStartSchema: () =>
      import('../../../src/main/runtime/rpc/methods/orchestration/federation/federation-start-schema'),
    fleetSnapshot: () =>
      import('../../../src/main/runtime/rpc/methods/orchestration/federation/federated-fleet-snapshot')
  }
  return async (key) => (await modules[key]()) as Record<string, unknown>
}

function releaseLoader(checkout: ReleaseCheckout): ModuleLoader {
  return async (key) => {
    for (const candidate of MODULE_ALIASES[key]) {
      try {
        await access(join(checkout.root, candidate.slice(1)), constants.F_OK)
      } catch {
        continue
      }
      return await importReleaseCheckoutModule(checkout, candidate)
    }
    return null
  }
}

/**
 * Load the orchestration federation surface for one build. `WORKING_TREE` imports
 * current source; any other value is a git ref extracted into a cached checkout.
 */
export async function loadOrchestrationWireBuild(ref: string): Promise<OrchestrationWireBuild> {
  if (ref === WORKING_TREE) {
    return assembleBuild({
      label: WORKING_TREE,
      revision: WORKING_TREE,
      load: workingTreeLoader()
    })
  }
  const checkout = await materializeReleaseCheckout(ref)
  return assembleBuild({
    label: checkout.ref,
    revision: checkout.commit,
    load: releaseLoader(checkout)
  })
}
