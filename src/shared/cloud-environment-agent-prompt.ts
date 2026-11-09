import { redactEphemeralVmRecipeDiagnosticText } from './ephemeral-vm-recipe-diagnostic-redaction'

export type CloudEnvironmentAgentPromptFailure = {
  buildNumber?: number
  /** `boot` | `clone` | `install` | `record` | `snapshot`. */
  failedStep?: string | null
  /** Control-plane error code such as `install_failed` or `exit_1`. */
  error?: string | null
  log?: string
}

const MAX_LOG_LINES = 60
const MAX_LOG_CHARS = 6_000
const MAX_INLINE_CHARS = 300
const MAX_LISTED = 20
// Only values that cannot break out of an inline code span reach the prompt verbatim.
const SAFE_ENV_ID = /^env_[0-9a-f]{8,40}$/
const SAFE_REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(?:\.git)?$/
const SAFE_ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const BEARER_TOKEN = /\b(authorization\s*:\s*(?:bearer|token|basic)\s+)\S+/gi
const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi

/** Prompt for "Configure with an agent": a local agent writes the org environment's install script
 *  and builds it until it succeeds, through the narrow `orca cloud env` CLI. */
export function buildCloudEnvironmentAgentPrompt(args: {
  envId?: string
  environmentName?: string
  repos?: readonly string[]
  envVarNames?: readonly string[]
  failure?: CloudEnvironmentAgentPromptFailure
}): string {
  const envFlag = args.envId && SAFE_ENV_ID.test(args.envId) ? ` --env ${args.envId}` : ''
  const name = args.environmentName ? oneLine(args.environmentName) : ''
  const repos = (args.repos ?? []).filter((url) => SAFE_REPO_URL.test(url)).slice(0, MAX_LISTED)
  const names = (args.envVarNames ?? [])
    .filter((value) => SAFE_ENV_VAR_NAME.test(value))
    .slice(0, MAX_LISTED * 5)
  const lines = [
    `Set up the Orca Cloud environment${name ? ` "${name}"` : ''} so every new cloud workspace boots with its dependencies installed.`,
    '',
    'How it works: Orca boots a fresh Linux VM, clones the environment’s repos, runs its install script once, and snapshots the result. Workspaces start from the snapshot.',
    '- The install script is bash. It runs once per build with `set -euo pipefail`, from the first repo’s checkout, as a user with passwordless sudo. The build log’s first line says the base image and its package manager (currently Ubuntu with apt-get).',
    '- Org secrets listed in the environment are exported to the script as environment variables.',
    '',
    'Steps:',
    `1. Run \`orca cloud env show${envFlag} --json\` to read the current repos, install script and latest build.`,
    '2. Inspect the repos (in this checkout and any sibling checkouts) to learn what they need: language runtimes and versions, package managers and lockfiles, system packages, build steps, codegen.',
    '3. Write the install script to a local file outside the repo (for example in a temp dir). Prefer the lockfile-exact install commands, pin runtime versions the repo declares, and keep it idempotent.',
    `4. Save it with \`orca cloud env set-install-script${envFlag} --file <path>\`.`,
    `5. Run \`orca cloud env build${envFlag} --wait\`. It streams the build log and exits non-zero on failure, printing the failed step and error. Lines starting with \`::orca-error::\` are Orca’s own explanation.`,
    '6. Read the failure, fix the script, and repeat steps 4-5 until a build succeeds. Each build boots a real VM, so fix everything you can see before rebuilding.',
    '',
    'Rules:',
    '- Never print, echo, log or write secret values, and never put them in the script. Refer to them only as `$NAME`.',
    '- Do not try to change the repos, the environment variable names, the machine size or any secret: you cannot, and they belong to the org admins. If one of those is the blocker, stop and say exactly what an admin should change.',
    '- Do not commit or push anything to the repos for this task.',
    '- Finish with a short summary: what the script installs, the succeeded build number, and anything an admin should follow up on.'
  ]
  if (repos.length > 0) {
    lines.push('', 'Repos in this environment (the first one is the working directory):')
    lines.push(...repos.map((url) => `- ${url}`))
  }
  if (names.length > 0) {
    lines.push(
      '',
      `Secrets exported to the script: ${names.map((value) => `\`${value}\``).join(', ')}.`
    )
  }
  if (args.failure) {
    const what = [
      args.failure.buildNumber && Number.isInteger(args.failure.buildNumber)
        ? `Build #${args.failure.buildNumber}`
        : 'The last build',
      'failed',
      args.failure.failedStep ? `at the ${oneLine(args.failure.failedStep)} step` : '',
      args.failure.error ? `(${oneLine(args.failure.error)})` : ''
    ]
      .filter(Boolean)
      .join(' ')
    lines.push('', `${what}.`)
    const tail = logTail(args.failure.log)
    if (tail) {
      lines.push('Last output:', '```', tail, '```')
    }
  }
  return lines.join('\n')
}

function logTail(log: string | undefined): string {
  if (!log?.trim()) {
    return ''
  }
  // Redact before cutting: a cut inside a URL would hide its scheme from the redactor.
  const tail = redact(log.trimEnd()).split(/\r?\n/).slice(-MAX_LOG_LINES).join('\n')
  return tail.length > MAX_LOG_CHARS ? tail.slice(-MAX_LOG_CHARS) : tail
}

/** Inline text stays one bounded, redacted line so it cannot pose as prompt structure. */
function oneLine(text: string): string {
  const flat = redact(text).replace(/[`"]/g, "'").replace(/\s+/g, ' ').trim()
  return flat.length > MAX_INLINE_CHARS ? `${flat.slice(0, MAX_INLINE_CHARS)}…` : flat
}

function redact(text: string): string {
  // A fence inside the log would close ours and let log text read as instructions.
  return redactEphemeralVmRecipeDiagnosticText(text)
    .replace(BEARER_TOKEN, '$1[redacted]')
    .replace(SECRET_ASSIGNMENT, '$1[redacted]')
    .replace(/```/g, "'''")
}
