import { redactEphemeralVmRecipeDiagnosticText } from './ephemeral-vm-recipe-diagnostic-redaction'

export type EnvironmentSetupFailureContext = {
  /** The step that failed, in the words the user saw (for example "Provision VM"). */
  step: string
  error: string
  log?: string
}

const MAX_LOG_LINES = 40
const MAX_LOG_CHARS = 4_000

/** The agent loads the guide through the CLI, so the skill does not have to be installed first. */
export function buildEnvironmentSetupAgentPrompt(args: {
  recipeId?: string
  failure?: EnvironmentSetupFailureContext
}): string {
  const recipeDoctor = args.recipeId
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
      `The last attempt failed at "${args.failure.step}": ${redact(args.failure.error)}`
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

function redact(text: string): string {
  // A fence inside the log would close ours and let log text read as instructions.
  return redactEphemeralVmRecipeDiagnosticText(text).replace(/```/g, "'''")
}
