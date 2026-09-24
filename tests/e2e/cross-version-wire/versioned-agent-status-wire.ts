import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  type ReleaseCheckout
} from './release-checkout'

/**
 * One build's agent-status wire endpoints: the store that authors snapshots and mutation
 * envelopes, the subject maker that names who a row is about, the child-work admission
 * that writes rows, and the OSC payload parser that ingests what an agent CLI prints.
 *
 * Every export is read from the build under test, so nothing here states what a release
 * does or does not have. A release that predates an export fails to load and says so.
 */

export const WORKING_TREE = 'working-tree' as const

type AnyRecord = Record<string, unknown>

export type AgentStatusStoreLike = {
  getParent: (subject: unknown) => AnyRecord | null
  getChild: (childWorkId: string) => AnyRecord | null
  getSnapshot: () => AnyRecord
  applyMutation: (mutation: unknown) => AnyRecord | null
  applySnapshot: (snapshot: unknown) => boolean
  applyTransportEnvelope: (envelope: unknown) => boolean
}

export type AgentStatusWireBuild = {
  /** Human label used in test names and failure messages. */
  label: string
  /** `working-tree` for current code, otherwise the resolved release commit. */
  revision: string
  /** Status arms this build can name, read from the build rather than written down. */
  states: readonly string[]
  createStore: (options: { epoch: string; mode: 'authority' | 'replica' }) => AgentStatusStoreLike
  makeStructuredSubject: (scope: unknown, sessionId: string) => unknown
  announceChild: (store: AgentStatusStoreLike, childWorkId: string, request: unknown) => AnyRecord
  /** Normalize an OSC status payload the way this build's host ingress does. */
  normalizeStatusPayload: (payload: unknown) => AnyRecord | null
}

type StoreModule = {
  createAgentStatusStore: (options: { epoch: string; mode: string }) => AgentStatusStoreLike
}
type SubjectModule = {
  makeStructuredAgentStatusSubject: (scope: unknown, sessionId: string) => unknown
}
type AdmissionModule = {
  createAgentChildWorkAdmission: (
    store: AgentStatusStoreLike,
    options: { mintChildWorkId: () => string }
  ) => { announce: (request: unknown) => AnyRecord }
}
type TypesModule = {
  AGENT_STATUS_STATES: readonly string[]
  normalizeAgentStatusPayload: (payload: unknown) => AnyRecord | null
}

type LoadedModules = {
  store: StoreModule
  subject: SubjectModule
  admission: AdmissionModule
  types: TypesModule
}

/** Every export a pairing reads, proven present before any assertion runs. */
function requireExports(label: string, modules: Record<string, AnyRecord>): LoadedModules {
  const missing = [
    ['store', 'createAgentStatusStore'],
    ['subject', 'makeStructuredAgentStatusSubject'],
    ['admission', 'createAgentChildWorkAdmission'],
    ['types', 'normalizeAgentStatusPayload']
  ].filter(([module, name]) => typeof modules[module ?? '']?.[name ?? ''] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      `Build ${label} is missing agent-status wire exports: ${missing
        .map(([module, name]) => `${name} (${module})`)
        .join(', ')}`
    )
  }
  const states = modules.types?.AGENT_STATUS_STATES
  if (!Array.isArray(states) || states.some((state) => typeof state !== 'string')) {
    throw new Error(`Build ${label} publishes no AGENT_STATUS_STATES arm set`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every export read below was just proven callable, and the arm set proven to be strings.
  return modules as unknown as LoadedModules
}

function assembleBuild(
  label: string,
  revision: string,
  modules: LoadedModules
): AgentStatusWireBuild {
  return {
    label,
    revision,
    states: modules.types.AGENT_STATUS_STATES,
    createStore: (options) => modules.store.createAgentStatusStore(options),
    makeStructuredSubject: (scope, sessionId) =>
      modules.subject.makeStructuredAgentStatusSubject(scope, sessionId),
    announceChild: (store, childWorkId, request) =>
      modules.admission
        .createAgentChildWorkAdmission(store, { mintChildWorkId: () => childWorkId })
        .announce(request),
    normalizeStatusPayload: (payload) => modules.types.normalizeAgentStatusPayload(payload)
  }
}

async function loadWorkingTreeBuild(): Promise<AgentStatusWireBuild> {
  const [store, subject, admission, types] = await Promise.all([
    import('../../../src/shared/agent-status-store'),
    import('../../../src/shared/agent-status-subject'),
    import('../../../src/shared/agent-status-child-work-admission'),
    import('../../../src/shared/agent-status-types')
  ])
  return assembleBuild(
    WORKING_TREE,
    WORKING_TREE,
    requireExports(WORKING_TREE, { store, subject, admission, types })
  )
}

async function loadReleaseBuild(checkout: ReleaseCheckout): Promise<AgentStatusWireBuild> {
  const [store, subject, admission, types] = await Promise.all([
    importReleaseCheckoutModule(checkout, '/src/shared/agent-status-store.ts'),
    importReleaseCheckoutModule(checkout, '/src/shared/agent-status-subject.ts'),
    importReleaseCheckoutModule(checkout, '/src/shared/agent-status-child-work-admission.ts'),
    importReleaseCheckoutModule(checkout, '/src/shared/agent-status-types.ts')
  ])
  return assembleBuild(
    checkout.ref,
    checkout.commit,
    requireExports(checkout.ref, { store, subject, admission, types })
  )
}

/**
 * Load the agent-status wire surface for one build. `WORKING_TREE` imports current
 * source; any other value is a git ref extracted into a cached checkout.
 */
export async function loadAgentStatusWireBuild(ref: string): Promise<AgentStatusWireBuild> {
  if (ref === WORKING_TREE) {
    return loadWorkingTreeBuild()
  }
  return loadReleaseBuild(await materializeReleaseCheckout(ref))
}
