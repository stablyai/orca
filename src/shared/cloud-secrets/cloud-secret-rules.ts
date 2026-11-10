// Client-side mirror of the control plane's secret rules (cloud/apps/sandbox-control/src/secrets.ts),
// so the editor and the .env preview flag a bad line before anything is sent. The server stays the authority.
import type { CloudSecretKind, CloudSecretsErrorCode } from './cloud-secrets-wire'

const NAME = /^[A-Z_][A-Z0-9_]*$/
const MAX_NAME_LENGTH = 128
export const MAX_CLOUD_SECRET_VALUE_BYTES = 8 * 1024

/** For these, a team-shared value beats a personal one. */
const AGENT_KEY_NAMES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'AI_GATEWAY_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'CURSOR_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_MODEL'
])

/**
 * Credentials agents and their model providers read. Any of these the egress proxy cannot swap
 * reaches a cloud sandbox as its real value, so the UI marks it "Real value in sandbox": AWS keys
 * (requests are signed in the VM with SigV4), Bedrock API keys (not routed yet) and every provider
 * key below that has no swap route. A control-plane test keeps this in step with the proxy.
 */
export const AGENT_CREDENTIAL_NAMES: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'TOGETHER_AI_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'CEREBRAS_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'DASHSCOPE_API_KEY',
  'ZAI_API_KEY',
  'ZHIPU_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_API_KEY',
  'COHERE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'AMP_API_KEY',
  'FACTORY_API_KEY',
  'AUGMENT_API_KEY',
  'CODEBUFF_API_KEY',
  'CLINE_API_KEY',
  'QWEN_API_KEY',
  // Swapped (no badge): listed so the test sees every agent credential in one place.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AI_GATEWAY_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'CURSOR_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN'
]

/** Agent credentials the egress proxy swaps: a sandbox only ever holds a stand-in for these. */
export const CLOUD_SWAPPED_CREDENTIALS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AI_GATEWAY_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'CURSOR_API_KEY',
  'GOOGLE_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN'
]

export function cloudSecretSwapped(name: string): boolean {
  return CLOUD_SWAPPED_CREDENTIALS.includes(name)
}

/** An agent credential a cloud sandbox gets in full (no egress stand-in for it). */
export function cloudSecretStoredOnVm(name: string): boolean {
  return AGENT_CREDENTIAL_NAMES.includes(name) && !cloudSecretSwapped(name)
}

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'LANG',
  'TERM',
  'TMPDIR',
  'IFS',
  'ENV',
  'BASH_ENV',
  'PS4',
  'PROMPT_COMMAND',
  'SHELLOPTS',
  'BASHOPTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
  'JAVA_TOOL_OPTIONS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_PROXY_COMMAND',
  'SSH_AUTH_SOCK',
  'GH_TOKEN',
  'GITHUB_TOKEN'
])
const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'ORCA_', 'VERCEL_', 'BASH_FUNC_', 'GIT_CONFIG']
const MODEL_NAMES: ReadonlySet<string> = new Set([
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'OPENAI_MODEL'
])
const BASE_URL_NAMES: ReadonlySet<string> = new Set(['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'])
const JWT_SHAPE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/

export function cloudSecretKind(name: string): CloudSecretKind {
  return AGENT_KEY_NAMES.has(name) ? 'agent_key' : 'env'
}

export function cloudSecretNameError(name: string): CloudSecretsErrorCode | null {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || !NAME.test(name)) {
    return 'invalid_name'
  }
  if (name === 'CLAUDE_CODE_OAUTH_TOKEN') {
    return 'subscription_token_refused'
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return 'reserved_name'
  }
  return null
}

export function cloudSecretValueError(name: string, value: string): CloudSecretsErrorCode | null {
  if (value.length === 0 || value.includes('\0')) {
    return 'invalid_value'
  }
  if (new TextEncoder().encode(value).length > MAX_CLOUD_SECRET_VALUE_BYTES) {
    return 'value_too_large'
  }
  const trimmed = value.trim()
  if (trimmed.startsWith('sk-ant-oat')) {
    return 'subscription_token_refused'
  }
  if ((name === 'ANTHROPIC_API_KEY' || name === 'OPENAI_API_KEY') && JWT_SHAPE.test(trimmed)) {
    return 'subscription_token_refused'
  }
  // The VM reads these unquoted, so the server takes only printable ASCII without spaces.
  const bare = /^[\x21-\x7e]+$/.test(value)
  if (BASE_URL_NAMES.has(name) && (!bare || !isPublicHttpsUrl(value))) {
    return 'invalid_base_url'
  }
  if (MODEL_NAMES.has(name) && !bare) {
    return 'invalid_value'
  }
  return null
}

/** https on a host that is not obviously private; the server re-checks with DNS-free rules of its own. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return false
  }
  const host = url.hostname.toLowerCase()
  return (
    host.includes('.') &&
    host !== 'localhost' &&
    !host.endsWith('.local') &&
    !host.endsWith('.internal') &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
    !host.startsWith('[')
  )
}
