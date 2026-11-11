// What S0 (Settings › Agent accounts › Orca Cloud) and the composer's Agent row show for each agent,
// derived from GET /v1/agent-credentials + /v1/agent-sources and the setup running on this computer.
import type { CloudEffectiveSecret } from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import {
  isUsableAgentCredential,
  orcaCloudProviderState,
  type AgentKeyKind,
  type OrcaCloudAccountAgent,
  type OrcaCloudAgentSetup,
  type OrcaCloudAgentSetupFailure,
  type OrcaCloudAgentsStatus
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { OrcaCloudAgentAccountsState } from './orca-cloud-agent-accounts-store'

/** The names that make a key cover an agent, as the control plane counts them (coveredByKey). */
const KEY_NAMES: Record<OrcaCloudAccountAgent, readonly string[]> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'AI_GATEWAY_API_KEY'
  ],
  codex: ['OPENAI_API_KEY', 'AI_GATEWAY_API_KEY']
}

/** Which key wins for each agent (Team > Repository > Personal), for "team key" / "your API key". */
export function agentKeyKinds(
  effective: readonly Pick<CloudEffectiveSecret, 'name' | 'scope'>[]
): Record<OrcaCloudAccountAgent, AgentKeyKind | null> {
  const kindFor = (agent: OrcaCloudAccountAgent): AgentKeyKind | null => {
    const scopes = new Set(
      effective.filter((secret) => KEY_NAMES[agent].includes(secret.name)).map((s) => s.scope)
    )
    return scopes.has('org')
      ? 'team'
      : scopes.has('repo')
        ? 'repository'
        : scopes.has('personal')
          ? 'personal'
          : null
  }
  return { claude: kindFor('claude'), codex: kindFor('codex') }
}

/** One S0 row (spec §5 states 2–9). `keyKind` is the key a row falls back to, when one covers it. */
export type OrcaCloudAccountRow =
  | { kind: 'notSetUp'; keyKind: AgentKeyKind | null }
  | {
      kind: 'setup'
      setup: Exclude<OrcaCloudAgentSetup, { phase: 'idle' | 'saved' | 'failed' }>
    }
  | { kind: 'failed'; error: OrcaCloudAgentSetupFailure }
  /** State 7: set up, and a key already covers the agent, and no default Source was chosen yet. */
  | { kind: 'choice'; keyKind: AgentKeyKind | null }
  | {
      kind: 'active'
      label: string | null
      expiresAt: number | null
      expiring: boolean
      source: 'sign-in' | 'key'
      keyKind: AgentKeyKind | null
      covered: boolean
    }
  | { kind: 'expired'; keyKind: AgentKeyKind | null; covered: boolean }
  /** §5c: the provider's Orca-account path is paused (kill switch). Info only; the stored credential is kept. */
  | { kind: 'killSwitch' }
  /** This server never offered the provider (flag off): nothing to set up, nothing paused. */
  | { kind: 'unavailable' }

export function orcaCloudAccountRow(
  agent: OrcaCloudAccountAgent,
  status: OrcaCloudAgentsStatus,
  setup: OrcaCloudAgentSetup,
  keyKind: AgentKeyKind | null
): OrcaCloudAccountRow {
  const credential = status.credentials[agent]
  const covered = status.sources.coveredByKey[agent]
  const fallbackKey = covered ? (keyKind ?? 'team') : null
  switch (orcaCloudProviderState(status.credentials, agent)) {
    case 'off':
      return { kind: 'unavailable' }
    case 'disabled':
      return { kind: 'killSwitch' }
    case 'on':
      break
  }
  if (setup.phase === 'failed') {
    return { kind: 'failed', error: setup.error }
  }
  if (setup.phase !== 'idle' && setup.phase !== 'saved') {
    return { kind: 'setup', setup }
  }
  if (credential.state === 'none') {
    return { kind: 'notSetUp', keyKind: fallbackKey }
  }
  if (!isUsableAgentCredential(credential.state)) {
    return { kind: 'expired', keyKind: fallbackKey, covered }
  }
  const chosen = status.sources.defaults[agent] ?? null
  if (covered && chosen === null) {
    return { kind: 'choice', keyKind: fallbackKey }
  }
  return {
    kind: 'active',
    label: credential.label?.trim() || null,
    expiresAt: credential.expiresAt ?? null,
    expiring: credential.state === 'expiring',
    // With no key covering the agent, a usable account is the source whatever was chosen.
    source: covered && chosen === 'key' ? 'key' : 'sign-in',
    keyKind: fallbackKey,
    covered
  }
}

/** How a new cloud workspace authenticates this agent, for the composer's Agent row (G). */
export type OrcaCloudAgentCoverage =
  | { kind: 'account' }
  | { kind: 'key'; keyKind: AgentKeyKind }
  | { kind: 'notSetUp' }
  | { kind: 'expired' }
  /** §5c without a key: each new cloud workspace asks once. */
  | { kind: 'killSwitch' }
  /** Flag off without a key: no Orca-account path here, so nothing to show. */
  | { kind: 'unavailable' }

export function orcaCloudAgentCoverage(
  agent: OrcaCloudAccountAgent,
  status: OrcaCloudAgentsStatus,
  keyKind: AgentKeyKind | null
): OrcaCloudAgentCoverage {
  const credential = status.credentials[agent]
  const provider = orcaCloudProviderState(status.credentials, agent)
  const covered = status.sources.coveredByKey[agent]
  const usable = provider === 'on' && isUsableAgentCredential(credential.state)
  const source = status.sources.effective?.[agent]?.source ?? status.sources.defaults[agent] ?? null
  const key: OrcaCloudAgentCoverage = { kind: 'key', keyKind: keyKind ?? 'team' }
  if (usable && (source === 'sign-in' || !covered)) {
    return { kind: 'account' }
  }
  if (covered) {
    return key
  }
  if (provider !== 'on') {
    return { kind: provider === 'off' ? 'unavailable' : 'killSwitch' }
  }
  return credential.state === 'expired' || credential.state === 'revoked'
    ? { kind: 'expired' }
    : { kind: 'notSetUp' }
}

/** The renderer's one Agent accounts read, as the coverage selectors take it. */
export type OrcaCloudAgentAccountsRead = Pick<OrcaCloudAgentAccountsState, 'load' | 'keyKinds'>

/**
 * One agent's coverage from the shared Agent accounts read; null until that read is ready.
 * The single selector for every cloud surface that reacts to it: the launch hold and strip
 * (cloudAgentStripReason) and the sidebar/dashboard agent rows (cloudAgentRowSignIn).
 */
export function orcaCloudAgentCoverageFromAccounts(
  agent: OrcaCloudAccountAgent,
  accounts: OrcaCloudAgentAccountsRead
): OrcaCloudAgentCoverage | null {
  return accounts.load.kind === 'ready'
    ? orcaCloudAgentCoverage(agent, accounts.load.status, accounts.keyKinds[agent])
    : null
}
