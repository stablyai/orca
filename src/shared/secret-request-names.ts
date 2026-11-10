import { AGENT_CREDENTIAL_NAMES } from './agent-credentials/agent-credential-names'
import { SECRET_REQUEST_ERRORS } from './secret-request-contract'

// The control plane's secret-name rules (cloud/apps/sandbox-control/src/secrets.ts checkName), so a
// request the Worker would refuse is refused before anyone is asked. secret-request-names.test.ts
// diffs these lists against the Worker source.
const NAME = /^[A-Z_][A-Z0-9_]*$/
const MAX_NAME_LENGTH = 128

export const WORKER_RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
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
  'GITHUB_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
])

export const WORKER_RESERVED_SECRET_PREFIXES: readonly string[] = [
  'LD_',
  'DYLD_',
  'ORCA_',
  'VERCEL_',
  'BASH_FUNC_',
  'GIT_CONFIG'
]

const AGENT_CREDENTIALS: ReadonlySet<string> = new Set(Object.values(AGENT_CREDENTIAL_NAMES).flat())

/** Null when an agent may request this name; otherwise the error code to return. */
export function secretRequestNameRefusal(name: string): string | null {
  if (name.length > MAX_NAME_LENGTH || !NAME.test(name)) {
    return SECRET_REQUEST_ERRORS.invalidName
  }
  if (name === 'CLAUDE_CODE_OAUTH_TOKEN') {
    return SECRET_REQUEST_ERRORS.subscriptionTokenRefused
  }
  if (
    WORKER_RESERVED_SECRET_NAMES.has(name) ||
    WORKER_RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    return SECRET_REQUEST_ERRORS.reservedName
  }
  // Agent keys come from the person's sign-in or Cloud secrets, never from an agent's request.
  if (AGENT_CREDENTIALS.has(name)) {
    return SECRET_REQUEST_ERRORS.agentCredential
  }
  return null
}
