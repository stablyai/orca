// One read of the Orca Cloud agent accounts per renderer, shared by S0 and the composer's Agent row,
// plus the setup step main reports. Holds states and codes only; main keeps every credential.
import { useEffect, useSyncExternalStore } from 'react'
import {
  IDLE_ORCA_CLOUD_AGENT_SETUPS,
  ORCA_CLOUD_ACCOUNT_AGENTS,
  type AgentCredentialsView,
  type AgentKeyKind,
  type AgentSourcesView,
  type OrcaCloudAccountAgent,
  type OrcaCloudAgentSetups,
  type OrcaCloudAgentsErrorCode,
  type OrcaCloudAgentsStatus
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { agentKeyKinds } from './orca-cloud-agent-accounts-model'

export type OrcaCloudAgentAccountsLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; status: OrcaCloudAgentsStatus }
  | { kind: 'failed'; error: OrcaCloudAgentsErrorCode }
  /** No control plane in this build. */
  | { kind: 'unavailable' }

export type OrcaCloudAgentAccountsState = {
  load: OrcaCloudAgentAccountsLoad
  setups: OrcaCloudAgentSetups
  keyKinds: Record<OrcaCloudAccountAgent, AgentKeyKind | null>
  /** Names (never values) of the Cloud secrets a new workspace gets; null until read (JA-22). */
  cloudSecretNames?: ReadonlySet<string> | null
  /** The build sheet's R2 Set up: agents set up in turn; `index` is the one running now. */
  queue: { agents: readonly OrcaCloudAccountAgent[]; index: number }
}

const NO_QUEUE: OrcaCloudAgentAccountsState['queue'] = { agents: [], index: 0 }

const NO_KEYS: OrcaCloudAgentAccountsState['keyKinds'] = { claude: null, codex: null }

let state: OrcaCloudAgentAccountsState = {
  load: { kind: 'loading' },
  setups: IDLE_ORCA_CLOUD_AGENT_SETUPS,
  keyKinds: NO_KEYS,
  cloudSecretNames: null,
  queue: NO_QUEUE
}
// Set once the queued agent's setup has left idle, so idle afterwards means it finished.
let queuedStarted = false
const listeners = new Set<() => void>()
let started = false
let generation = 0
// A reload is only needed when the last read is older than this, or something changed it.
const FRESH_MS = 30_000
let loadedAt = 0

function set(next: Partial<OrcaCloudAgentAccountsState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) {
    listener()
  }
}

function bridge(): NonNullable<typeof window.api.orcaCloudAgents> | null {
  return typeof window === 'undefined' ? null : (window.api?.orcaCloudAgents ?? null)
}

/** Re-reads the credentials and sources (and which key covers each agent). */
export async function reloadOrcaCloudAgentAccounts(): Promise<void> {
  const api = bridge()
  if (!api) {
    set({ load: { kind: 'unavailable' } })
    return
  }
  const mine = ++generation
  if (state.load.kind !== 'ready') {
    set({ load: { kind: 'loading' } })
  }
  const [result, effective] = await Promise.all([
    api.status().catch(() => ({ ok: false as const, error: 'unknown' as const })),
    window.api.cloudSecrets?.effective({}).catch(() => null) ?? Promise.resolve(null)
  ])
  if (mine !== generation) {
    return
  }
  loadedAt = Date.now()
  set({
    load: result.ok
      ? { kind: 'ready', status: result.value }
      : result.error === 'not_configured'
        ? { kind: 'unavailable' }
        : { kind: 'failed', error: result.error },
    keyKinds: effective?.ok ? agentKeyKinds(effective.value.secrets) : state.keyKinds,
    cloudSecretNames: effective?.ok
      ? new Set(effective.value.secrets.map((secret) => secret.name))
      : state.cloudSecretNames
  })
}

function start(): void {
  if (started) {
    return
  }
  const api = bridge()
  if (!api) {
    state = { ...state, load: { kind: 'unavailable' } }
    return
  }
  started = true
  void api.setups().then(
    (setups) => set({ setups }),
    () => {}
  )
  api.onSetupChanged((setups) => {
    set({ setups })
    advanceQueue(setups)
    // A finished setup changes the stored credential: read it, then let main go back to idle.
    for (const agent of ORCA_CLOUD_ACCOUNT_AGENTS) {
      if (setups[agent].phase === 'saved') {
        void reloadOrcaCloudAgentAccounts().then(() => api.acknowledge({ agent }))
      }
    }
  })
}

function startQueued(agent: OrcaCloudAccountAgent): void {
  queuedStarted = false
  void bridge()?.start({ agent })
}

/** Moves R2's queue on when the running agent's setup finishes; a failure holds it for Try again. */
function advanceQueue(setups: OrcaCloudAgentSetups): void {
  const { agents, index } = state.queue
  const current = agents[index]
  if (!current) {
    return
  }
  const phase = setups[current].phase
  if (phase !== 'idle') {
    queuedStarted = phase !== 'failed' || queuedStarted
    return
  }
  if (!queuedStarted) {
    return
  }
  const next = agents[index + 1]
  set({ queue: next ? { agents, index: index + 1 } : NO_QUEUE })
  if (next) {
    startQueued(next)
  }
}

/** R2's Set up (and Try again): S0's setup for each agent in turn, inside the build sheet's row. */
export function runOrcaCloudAgentSetups(agents: readonly OrcaCloudAccountAgent[]): void {
  const { agents: queued, index } = state.queue
  // Try again after a failure resumes the queue at the failed agent.
  const resume = queued[index] !== undefined && queued[index] === agents[0]
  const queue = resume ? state.queue : { agents, index: 0 }
  const first = queue.agents[queue.index]
  if (!first) {
    return
  }
  set({ queue })
  startQueued(first)
}

/** Cancel stops the agent running now and drops the rest; a dismissed failure only drops them. */
export function stopOrcaCloudAgentSetups(cancel?: OrcaCloudAccountAgent): void {
  set({ queue: NO_QUEUE })
  if (cancel) {
    void bridge()?.cancel({ agent: cancel })
  }
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current read, for code outside React (the cloud launch hold). */
export function readOrcaCloudAgentAccounts(): OrcaCloudAgentAccountsState {
  return state
}

/** Listens for changes outside React; also starts the setup subscription once. */
export function subscribeOrcaCloudAgentAccounts(listener: () => void): () => void {
  return subscribe(listener)
}

/** Reads again when the last read is stale or missing, for a launch about to decide. */
/** When the current account view was read (ms); 0 before the first read. */
export function orcaCloudAgentAccountsLoadedAt(): number {
  return loadedAt
}

/** A ready read from within the last 30 s; older reads may miss a revoke (RA-1). */
export function isOrcaCloudAgentAccountsFresh(): boolean {
  return state.load.kind === 'ready' && Date.now() - loadedAt <= FRESH_MS
}

export async function ensureFreshOrcaCloudAgentAccounts(): Promise<OrcaCloudAgentAccountsState> {
  if (state.load.kind !== 'ready' || Date.now() - loadedAt > FRESH_MS) {
    await reloadOrcaCloudAgentAccounts()
  }
  return state
}

/** S0 and the Agent row; reads once on mount when the last read is stale. */
export function useOrcaCloudAgentAccounts(enabled = true): OrcaCloudAgentAccountsState {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
  useEffect(() => {
    if (enabled && (state.load.kind !== 'ready' || Date.now() - loadedAt > FRESH_MS)) {
      void reloadOrcaCloudAgentAccounts()
    }
  }, [enabled])
  return snapshot
}

/** A write's reply is the new view: apply it without another read. */
export function applyOrcaCloudAgentCredentials(credentials: AgentCredentialsView): void {
  if (state.load.kind === 'ready') {
    set({ load: { kind: 'ready', status: { ...state.load.status, credentials } } })
  }
  // The implicit Source depends on the credential, so the sources view moves too.
  void reloadOrcaCloudAgentAccounts()
}

export function applyOrcaCloudAgentSources(sources: AgentSourcesView): void {
  if (state.load.kind === 'ready') {
    set({ load: { kind: 'ready', status: { ...state.load.status, sources } } })
  }
}

/** Fixtures and tests only. */
export function setOrcaCloudAgentAccountsStateForTest(next: OrcaCloudAgentAccountsState): void {
  started = true
  loadedAt = Date.now()
  set(next)
}
