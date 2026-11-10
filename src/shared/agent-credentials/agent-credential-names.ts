// Per-agent credential names (single source of truth; agent-sources contract §1). The Worker mirrors
// this list verbatim in cloud/apps/sandbox-control/src/agent-credential-names.ts.
export type CredentialAgent = 'claude' | 'codex'
export const AGENT_CREDENTIAL_NAMES: Record<CredentialAgent, readonly string[]> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'AWS_BEARER_TOKEN_BEDROCK',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'CLOUD_ML_REGION'
  ],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']
}
