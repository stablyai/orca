import type { sendPlan } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-mutation-plans'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  type ReleaseCheckout
} from './release-checkout'

/**
 * The two things that decide whether a structured agent session exists for a given
 * pairing: the capability strings a build can name, and the RPC methods it
 * registers. Both are read per build, so "the old side does not have it" is a fact
 * about a real release rather than a hand-written list.
 */

export const WORKING_TREE = 'working-tree' as const

/** Each build owns its own copy of the module-level host slot, so a host installed
 *  in current source is invisible to a release checkout's dispatcher. */
const STRUCTURED_HOST_REGISTRY =
  '/src/main/native-chat/agent-session-wire/structured-agent-session-registry.ts'
const MUTATION_PLANS =
  '/src/main/native-chat/agent-session-wire/structured-agent-session-mutation-plans.ts'
const MUTATION_ADMISSION =
  '/src/main/native-chat/agent-session-wire/structured-agent-session-mutation-admission.ts'

export type RpcReply = {
  id: string
  ok: boolean
  streaming?: true
  result?: unknown
  error?: { code: string; message: string }
}

export type RpcClientIdentity = {
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly string[]
  updateClientCapabilities?: (capabilities: readonly string[]) => void
  connectionId?: string
  clientId?: string
}

export type AgentSessionDispatcher = {
  dispatchStreaming: (
    request: { id: string; authToken: string; method: string; params?: unknown },
    reply: (message: string) => void,
    options?: RpcClientIdentity
  ) => Promise<void>
}

export type AgentSessionWireBuild = {
  /** Human label used in test names and failure messages. */
  label: string
  /** `working-tree` for current code, otherwise the resolved release commit. */
  revision: string
  /** Capability strings this build defines. A peer cannot advertise — nor a client
   *  ask for — a string its own source never names. */
  capabilities: readonly string[]
  protocolVersion: number
  /** RPC method names the build registers, read from source. */
  methodNames: readonly string[]
  /** A dispatcher carrying a method set this build really ships, so an
   *  unknown-method answer is about the method and not an empty registry. */
  createDispatcher: (runtime: unknown) => AgentSessionDispatcher
  /** Put a host in *this* build's slot. Loaded on call so a release that predates
   *  the surface stays loadable, and throws rather than no-opping so a build with
   *  no slot cannot read as a surface that answered. */
  installStructuredHost: (host: unknown) => Promise<void>
  /** This build's own admission of the `agentSession.send` params its host was handed. With no
   *  journal it stops after the fingerprint check: a fingerprint it derives differently refuses
   *  as `fingerprintMismatch`, one it agrees with as `sessionNotAttached`. */
  admitSend: (sent: SentMessage) => Promise<unknown>
}

type DispatcherModule = {
  RpcDispatcher: new (options: { runtime: unknown; methods: unknown[] }) => AgentSessionDispatcher
}

function registeredMethodNames(methods: readonly unknown[]): string[] {
  return methods
    .flatMap((method) => {
      if (!method || typeof method !== 'object' || !('name' in method)) {
        return []
      }
      const { name } = method
      return typeof name === 'string' ? [name] : []
    })
    .sort()
}

function applyStructuredHost(module: Record<string, unknown>, label: string, host: unknown): void {
  const install = module.setStructuredAgentSessionHost
  if (typeof install !== 'function') {
    throw new Error(`Build ${label} publishes no structured agent-session host registry`)
  }
  ;(install as (next: unknown) => void)(host)
}

/** The `agentSession.send` params a host is handed. */
export type SentMessage = Parameters<typeof sendPlan>[0]

type SendAdmissionModules = {
  sendPlan: (sent: SentMessage) => unknown
  admitAndRunAgentSessionMutation: (request: {
    plan: unknown
    envelope: SentMessage['envelope']
    journal: () => undefined
  }) => Promise<unknown>
}

async function admitSend(
  plans: Record<string, unknown>,
  admission: Record<string, unknown>,
  sent: SentMessage
): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the build's own send plan and admission; with no `prepareSession` it reads only plan, envelope and journal. A drifted export or shape fails this check.
  const build = { ...plans, ...admission } as unknown as SendAdmissionModules
  return build.admitAndRunAgentSessionMutation({
    plan: build.sendPlan(sent),
    envelope: sent.envelope,
    journal: () => undefined
  })
}

function capabilityStrings(module: Record<string, unknown>): readonly string[] {
  const declared = module.RUNTIME_CAPABILITIES
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error('Cross-version harness found no RUNTIME_CAPABILITIES to compare')
  }
  return declared as readonly string[]
}

async function loadWorkingTreeBuild(): Promise<AgentSessionWireBuild> {
  const [protocol, dispatcher, methodRegistry] = await Promise.all([
    import('../../../src/shared/protocol-version'),
    import('../../../src/main/runtime/rpc/dispatcher'),
    import('../../../src/main/runtime/rpc/methods')
  ])
  const module = dispatcher as unknown as DispatcherModule
  const methods = methodRegistry.ALL_RPC_METHODS as unknown[]
  return {
    label: WORKING_TREE,
    revision: WORKING_TREE,
    capabilities: capabilityStrings(protocol as unknown as Record<string, unknown>),
    protocolVersion: protocol.RUNTIME_PROTOCOL_VERSION,
    methodNames: registeredMethodNames(methods),
    createDispatcher: (runtime) =>
      new module.RpcDispatcher({
        runtime,
        methods
      }),
    installStructuredHost: async (host) => {
      const registry =
        await import('../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry')
      applyStructuredHost(registry as unknown as Record<string, unknown>, WORKING_TREE, host)
    },
    admitSend: async (sent) => {
      const [plans, admission] = await Promise.all([
        import('../../../src/main/native-chat/agent-session-wire/structured-agent-session-mutation-plans'),
        import('../../../src/main/native-chat/agent-session-wire/structured-agent-session-mutation-admission')
      ])
      return admitSend(plans, admission, sent)
    }
  }
}

async function loadReleaseBuild(checkout: ReleaseCheckout): Promise<AgentSessionWireBuild> {
  const [protocol, dispatcher, methodRegistry] = await Promise.all([
    importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts'),
    importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/dispatcher.ts'),
    importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/methods/index.ts')
  ])
  const module = dispatcher as unknown as DispatcherModule
  const methods = methodRegistry.ALL_RPC_METHODS as unknown[]
  return {
    label: checkout.ref,
    revision: checkout.commit,
    capabilities: capabilityStrings(protocol),
    protocolVersion: protocol.RUNTIME_PROTOCOL_VERSION as number,
    methodNames: registeredMethodNames(methods),
    createDispatcher: (runtime) =>
      new module.RpcDispatcher({
        runtime,
        methods
      }),
    installStructuredHost: async (host) => {
      applyStructuredHost(
        await importReleaseCheckoutModule(checkout, STRUCTURED_HOST_REGISTRY),
        checkout.ref,
        host
      )
    },
    admitSend: async (sent) => {
      const [plans, admission] = await Promise.all([
        importReleaseCheckoutModule(checkout, MUTATION_PLANS),
        importReleaseCheckoutModule(checkout, MUTATION_ADMISSION)
      ])
      return admitSend(plans, admission, sent)
    }
  }
}

/**
 * Load the structured-session wire surface for one build. `WORKING_TREE` imports
 * current source; any other value is a git ref extracted into a cached checkout.
 */
export async function loadAgentSessionWireBuild(ref: string): Promise<AgentSessionWireBuild> {
  if (ref === WORKING_TREE) {
    return loadWorkingTreeBuild()
  }
  return loadReleaseBuild(await materializeReleaseCheckout(ref))
}
