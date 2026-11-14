import { redactEphemeralVmRecipeDiagnosticText } from './ephemeral-vm-recipe-diagnostic-redaction'

export type EnvironmentSetupFailureContext = {
  /** The step that failed, in the words the user saw (for example "Provision VM"). */
  step: string
  error: string
  log?: string
}

const MAX_LOG_LINES = 40
const MAX_LOG_CHARS = 4_000
const MAX_ERROR_CHARS = 500
// Recipe ids are orca.yaml keys; anything else would break the inline code span.
const SAFE_RECIPE_ID = /^[A-Za-z0-9._-]{1,128}$/
// Unquoted secrets common in provisioning output; the shared redactor covers URLs and JSON fields.
const BEARER_TOKEN = /\b(authorization\s*:\s*(?:bearer|token|basic)\s+)\S+/gi
const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi

/** The agent loads the guide through the CLI, so the skill does not have to be installed first. */
export function buildEnvironmentSetupAgentPrompt(args: {
  recipeId?: string
  failure?: EnvironmentSetupFailureContext
}): string {
  const recipeDoctor =
    args.recipeId && SAFE_RECIPE_ID.test(args.recipeId)
      ? `\`orca vm recipe doctor ${args.recipeId} --json\``
      : '`orca vm recipe doctor <recipe-id> --json`'
  const lines = [
    'Use the orca-per-workspace-env skill to make this repo run in a per-workspace environment. If the skill is not installed, load it with `orca skills get orca-per-workspace-env`.',
    '',
    'Goal: write or repair `environmentRecipes` and `scripts.setup` in orca.yaml, plus any scripts they call.',
    `- Run ${recipeDoctor} and fix every failing check.`,
    '- Inside the environment, run `orca vm env doctor --run-setup --json` and fix what fails: missing CLIs, agent sign-in, Git access, the setup script, disk space.',
    '- Re-run both doctors after each fix until no check fails, and resolve or explain every warning.',
    '- Follow the skill: ask before any paid or interactive step, and never write a secret into a file or commit.',
    '- Work on a new branch. Finish with a commit and open a pull request that explains what changed.'
  ]
  if (args.failure) {
    lines.push(
      '',
      `The last attempt failed at "${oneLine(args.failure.step)}": ${oneLine(args.failure.error)}`
    )
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
  const flat = redact(text).replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}…` : flat
}

function redact(text: string): string {
  // A fence inside the log would close ours and let log text read as instructions.
  return redactEphemeralVmRecipeDiagnosticText(text)
    .replace(BEARER_TOKEN, '$1[redacted]')
    .replace(SECRET_ASSIGNMENT, '$1[redacted]')
    .replace(/```/g, "'''")
}
