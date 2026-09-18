export type AgentStatusLegacyIngressDestination = '2B' | '6'

export type AgentStatusLegacyIngressCaller =
  | 'main-status-update'
  | 'main-status-cleanup'
  | 'main-pane-alias-transfer'
  | 'main-status-hydration'
  | 'main-restored-status-reaping'
  | 'relay-status-cache'
  | 'shared-bounded-status-cache'

export type AgentStatusLegacyIngressManifestEntry = {
  caller: AgentStatusLegacyIngressCaller
  sourcePath: string
  reason: string
  owner: 'main-agent-hooks' | 'relay-agent-hooks' | 'shared-hook-listener'
  destination: AgentStatusLegacyIngressDestination
  gate: string
  allowedModes: readonly AgentStatusLegacyIngressModeKind[]
}

export type AgentStatusLegacyIngressModeKind =
  | 'current-producer'
  | 'older-peer'
  | 'persisted-hydration'

function entry(
  value: AgentStatusLegacyIngressManifestEntry
): Readonly<AgentStatusLegacyIngressManifestEntry> {
  return Object.freeze({ ...value, allowedModes: Object.freeze([...value.allowedModes]) })
}

/** Every writable legacy ingress. Entries may only disappear as their destination gate lands. */
export const AGENT_STATUS_LEGACY_INGRESS_MANIFEST = Object.freeze([
  entry({
    caller: 'main-status-update',
    sourcePath: 'src/main/agent-hooks/server/server-status-update.ts',
    reason: 'Hook, OSC, and unsupported-peer observations still use pane ownership in 2A.',
    owner: 'main-agent-hooks',
    destination: '2B',
    gate: 'Trusted PTY scope plus owner-atomic producer handover',
    allowedModes: ['current-producer', 'older-peer']
  }),
  entry({
    caller: 'main-status-cleanup',
    sourcePath: 'src/main/agent-hooks/server/server-cleanup.ts',
    reason: 'Legacy provider-session remnants preserve resume identity during pane cleanup.',
    owner: 'main-agent-hooks',
    destination: '2B',
    gate: 'Canonical run retirement and resume-identity mutation',
    allowedModes: ['current-producer']
  }),
  entry({
    caller: 'main-pane-alias-transfer',
    sourcePath: 'src/main/agent-hooks/server/server-authority-aliases.ts',
    reason: 'A verified pane remint transfers the existing legacy row without minting a run.',
    owner: 'main-agent-hooks',
    destination: '2B',
    gate: 'Scope-preserving canonical pane attachment relocation',
    allowedModes: ['current-producer']
  }),
  entry({
    caller: 'main-status-hydration',
    sourcePath: 'src/main/agent-hooks/server/server-hydration.ts',
    reason: 'Persisted pane evidence is quarantined until host evidence confirms ownership.',
    owner: 'main-agent-hooks',
    destination: '6',
    gate: 'Trusted adoption or bounded unconfirmed-observation retention expiry',
    allowedModes: ['persisted-hydration']
  }),
  entry({
    caller: 'main-restored-status-reaping',
    sourcePath: 'src/main/agent-hooks/server/server-reaping.ts',
    reason: 'Process-probe reconciliation can update a quarantined hydrated pane row.',
    owner: 'main-agent-hooks',
    destination: '6',
    gate: 'Canonical hydration adoption fixtures and compatibility-branch ablation',
    allowedModes: ['persisted-hydration']
  }),
  entry({
    caller: 'relay-status-cache',
    sourcePath: 'src/shared/agent-status-legacy-relay-cache.ts',
    reason: 'The relay retains receiver-fenced replay state until trusted host binding exists.',
    owner: 'relay-agent-hooks',
    destination: '2B',
    gate: 'Relay trusted scope binding plus owner-atomic producer handover',
    allowedModes: ['current-producer']
  }),
  entry({
    caller: 'shared-bounded-status-cache',
    sourcePath: 'src/shared/agent-hook-status-cache.ts',
    reason: 'The bounded legacy cache seam remains available to hook listener owners in 2A.',
    owner: 'shared-hook-listener',
    destination: '2B',
    gate: 'All hook listener owners use the canonical mutation core',
    allowedModes: ['current-producer']
  })
])

const LEGACY_INGRESS_BY_CALLER = new Map(
  AGENT_STATUS_LEGACY_INGRESS_MANIFEST.map((candidate) => [candidate.caller, candidate])
)
const CURRENT_PRODUCER_LEGACY_INGRESS_MANIFEST = Object.freeze(
  AGENT_STATUS_LEGACY_INGRESS_MANIFEST.filter((candidate) => candidate.destination === '2B')
)

export function findAgentStatusLegacyIngressManifestEntry(
  caller: AgentStatusLegacyIngressCaller
): Readonly<AgentStatusLegacyIngressManifestEntry> | undefined {
  return LEGACY_INGRESS_BY_CALLER.get(caller)
}

export function currentProducerAgentStatusLegacyIngressManifest(): readonly Readonly<AgentStatusLegacyIngressManifestEntry>[] {
  return CURRENT_PRODUCER_LEGACY_INGRESS_MANIFEST
}
