import type { AgentApiKeySummary } from '../../../../shared/agent-api-keys/agent-api-key-catalog'
import { cloudSecretSwapped } from '../../../../shared/cloud-secrets/cloud-secret-rules'
import type { CloudEffectiveSecret } from '../../../../shared/cloud-secrets/cloud-secrets-wire'

export type CloudSetupAgent = 'claude' | 'codex'
export const CLOUD_SETUP_AGENTS: readonly CloudSetupAgent[] = ['claude', 'codex']

/** Where an agent's credential comes from in a new cloud workspace, best first. */
export type CloudAgentCredentialSource = 'team' | 'cloud-secret'

export type CloudAgentReadiness = Record<CloudSetupAgent, CloudAgentCredentialSource | null>

/** Variables that alone let each CLI authenticate (the Worker derives the rest from a gateway key). */
const CREDENTIAL_NAMES: Record<CloudSetupAgent, readonly string[]> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'AI_GATEWAY_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX'
  ],
  codex: ['OPENAI_API_KEY', 'AI_GATEWAY_API_KEY']
}

/**
 * A team-shared key, then the user's own cloud secret. This computer's Agent API Keys never reach a
 * cloud VM (they would sit in it in plaintext); they are offered as Cloud secrets instead.
 */
export function deriveCloudAgentReadiness(
  effective: readonly Pick<CloudEffectiveSecret, 'name' | 'scope'>[]
): CloudAgentReadiness {
  const sourceFor = (agent: CloudSetupAgent): CloudAgentCredentialSource | null => {
    const names = CREDENTIAL_NAMES[agent]
    const supplied = effective.filter((secret) => names.includes(secret.name))
    if (supplied.some((secret) => secret.scope === 'org')) {
      return 'team'
    }
    return supplied.length > 0 ? 'cloud-secret' : null
  }
  return { claude: sourceFor('claude'), codex: sourceFor('codex') }
}

/** A key on this computer a cloud workspace could use if the user saves it as a Cloud secret. */
export type CloudOfferableDesktopKey = Pick<AgentApiKeySummary, 'id' | 'agent' | 'envName' | 'hint'>

/**
 * This computer's keys for every host whose variable no Cloud secret sets yet (a key scoped to some
 * hosts was never meant for a VM that does not exist yet). One entry per variable.
 */
export function offerableDesktopKeys(
  desktopKeys: readonly Pick<
    AgentApiKeySummary,
    'id' | 'agent' | 'envName' | 'hint' | 'hostScope'
  >[],
  effective: readonly Pick<CloudEffectiveSecret, 'name'>[]
): CloudOfferableDesktopKey[] {
  const inCloud = new Set(effective.map((secret) => secret.name))
  const seen = new Set<string>()
  const offers: CloudOfferableDesktopKey[] = []
  for (const key of desktopKeys) {
    // Only keys a workspace gets as a stand-in; anything else would sit on the VM in full.
    if (
      key.hostScope.kind !== 'all' ||
      !cloudSecretSwapped(key.envName) ||
      inCloud.has(key.envName) ||
      seen.has(key.envName)
    ) {
      continue
    }
    seen.add(key.envName)
    offers.push({ id: key.id, agent: key.agent, envName: key.envName, hint: key.hint })
  }
  return offers
}

export function isCloudAgentReady(readiness: CloudAgentReadiness): boolean {
  return CLOUD_SETUP_AGENTS.some((agent) => readiness[agent] !== null)
}
