import type { AgentApiKeySummary } from '../../../../shared/agent-api-keys/agent-api-key-catalog'
import type { CloudEffectiveSecret } from '../../../../shared/cloud-secrets/cloud-secrets-wire'

export type CloudSetupAgent = 'claude' | 'codex'
export const CLOUD_SETUP_AGENTS: readonly CloudSetupAgent[] = ['claude', 'codex']

/** Where an agent's credential comes from in a new cloud workspace, best first. */
export type CloudAgentCredentialSource = 'desktop-key' | 'team' | 'cloud-secret'

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
 * Desktop keys for every host reach a brand-new VM at agent launch, so they win (zero clicks); host-scoped
 * keys cannot name a VM that does not exist yet. Then a team-shared key, then the user's own cloud secret.
 */
export function deriveCloudAgentReadiness(
  desktopKeys: readonly Pick<AgentApiKeySummary, 'agent' | 'hostScope'>[],
  effective: readonly Pick<CloudEffectiveSecret, 'name' | 'scope'>[]
): CloudAgentReadiness {
  const sourceFor = (agent: CloudSetupAgent): CloudAgentCredentialSource | null => {
    if (desktopKeys.some((key) => key.agent === agent && key.hostScope.kind === 'all')) {
      return 'desktop-key'
    }
    const names = CREDENTIAL_NAMES[agent]
    const supplied = effective.filter((secret) => names.includes(secret.name))
    if (supplied.some((secret) => secret.scope === 'org')) {
      return 'team'
    }
    return supplied.length > 0 ? 'cloud-secret' : null
  }
  return { claude: sourceFor('claude'), codex: sourceFor('codex') }
}

export function isCloudAgentReady(readiness: CloudAgentReadiness): boolean {
  return CLOUD_SETUP_AGENTS.some((agent) => readiness[agent] !== null)
}
