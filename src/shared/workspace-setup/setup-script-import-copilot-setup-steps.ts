import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import {
  joinSetupScriptImportCommands,
  normalizeSetupScriptImportCommand,
  pushSetupScriptImportUnsupportedField
} from './setup-script-import-command-limits'
import { SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS } from './setup-script-import-limits'
import { asRecord, collectPresentFields, parseYamlObject } from './setup-script-import-parsers'

const COPILOT_SETUP_STEPS_PATH = '.github/workflows/copilot-setup-steps.yml'
// The only job the agent runs; any other job in the file is ignored there too.
const COPILOT_SETUP_JOB = 'copilot-setup-steps'
const POSIX_SHELLS = new Set(['bash', 'sh'])
// sudo administers the throwaway runner (e.g. freeing disk space); runner variables have no local value.
const RUNNER_ONLY_COMMAND = /(^|[^A-Za-z0-9_])sudo\b|\$\{?(GITHUB|RUNNER)_[A-Z_]+/
const GITHUB_WORKSPACE_REFERENCE = /\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE\b/g
const SAFE_WORKING_DIRECTORY = /^[A-Za-z0-9_@%+=:,./][A-Za-z0-9_@%+=:,./-]*$/

type RunDefaults = { shell?: unknown; workingDirectory?: unknown }
type ImportedStep = { run: string; workingDirectory?: string }

export async function inspectCopilotSetupStepsConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const workflow = parseYamlObject(await readFile(COPILOT_SETUP_STEPS_PATH))
  const job = asRecord(asRecord(workflow?.jobs)?.[COPILOT_SETUP_JOB])
  if (!workflow || !job || !Array.isArray(job.steps)) {
    return null
  }

  const unsupportedFields = collectPresentFields(job, ['services', 'env', 'container'])
  if (job.steps.length > SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS) {
    return null
  }
  const defaults = resolveRunDefaults(workflow, job)
  const imported: ImportedStep[] = []
  for (let index = 0; index < job.steps.length; index++) {
    const step = stepToImported(
      asRecord(job.steps[index]),
      defaults,
      `steps.${index}`,
      unsupportedFields
    )
    if (step) {
      imported.push(step)
    }
  }
  const setup = joinSetupScriptImportCommands(imported.map((step) => stepToShell(step, imported)))
  if (!setup) {
    return null
  }
  return {
    provider: 'copilot',
    label: 'GitHub Copilot',
    files: [COPILOT_SETUP_STEPS_PATH],
    setup,
    unsupportedFields
  }
}

function resolveRunDefaults(
  workflow: Record<string, unknown>,
  job: Record<string, unknown>
): RunDefaults {
  const workflowRun = asRecord(asRecord(workflow.defaults)?.run)
  const jobRun = asRecord(asRecord(job.defaults)?.run)
  return {
    shell: jobRun?.shell ?? workflowRun?.shell,
    workingDirectory: jobRun?.['working-directory'] ?? workflowRun?.['working-directory']
  }
}

function stepToImported(
  step: Record<string, unknown> | null,
  defaults: RunDefaults,
  prefix: string,
  unsupportedFields: string[]
): ImportedStep | null {
  if (!step) {
    return null
  }
  if (typeof step.uses === 'string') {
    // The workspace is already a checkout; other actions (toolchain installers) have no shell form.
    if (!/^actions\/checkout(@|$)/.test(step.uses.trim())) {
      pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.uses`)
    }
    return null
  }
  const rawRun = normalizeSetupScriptImportCommand(step.run)
  if (!rawRun) {
    return null
  }
  const shell = step.shell ?? defaults.shell
  if (shell !== undefined && (typeof shell !== 'string' || !POSIX_SHELLS.has(shell.trim()))) {
    pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.shell`)
    return null
  }
  // Conditions and step env are evaluated by Actions; running the step without them would change it.
  for (const field of ['if', 'env']) {
    if (step[field] !== undefined) {
      pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.${field}`)
      return null
    }
  }
  const run = rawRun.replace(GITHUB_WORKSPACE_REFERENCE, '${ORCA_WORKTREE_PATH}')
  if (run.includes('${{') || RUNNER_ONLY_COMMAND.test(run)) {
    pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.run`)
    return null
  }
  const workingDirectory = step['working-directory'] ?? defaults.workingDirectory
  if (workingDirectory === undefined) {
    return { run }
  }
  if (typeof workingDirectory !== 'string' || !SAFE_WORKING_DIRECTORY.test(workingDirectory)) {
    pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.working-directory`)
    return null
  }
  return { run, workingDirectory }
}

/** Each Actions step is its own process, so a subshell keeps one step's cd/exit/set from leaking. */
function stepToShell(step: ImportedStep, allSteps: ImportedStep[]): string {
  if (!step.workingDirectory) {
    return allSteps.length === 1 ? step.run : `(\n${step.run}\n)`
  }
  return `(\ncd ${step.workingDirectory} || exit 1\n${step.run}\n)`
}
