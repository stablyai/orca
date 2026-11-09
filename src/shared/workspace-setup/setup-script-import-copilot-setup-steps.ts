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
const RUNNER_ONLY_COMMAND =
  /(^|[^A-Za-z0-9_])sudo\b|\$\{?GITHUB_(ENV|PATH|OUTPUT|STEP_SUMMARY|STATE)\b/
const SAFE_WORKING_DIRECTORY = /^[A-Za-z0-9_@%+=:,./][A-Za-z0-9_@%+=:,./-]*$/

export async function inspectCopilotSetupStepsConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const workflow = parseYamlObject(await readFile(COPILOT_SETUP_STEPS_PATH))
  const job = asRecord(asRecord(workflow?.jobs)?.[COPILOT_SETUP_JOB])
  if (!job || !Array.isArray(job.steps)) {
    return null
  }

  const unsupportedFields = collectPresentFields(job, ['services', 'env', 'container'])
  const commands: string[] = []
  const steps = job.steps.slice(0, SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS)
  for (let index = 0; index < steps.length; index++) {
    const command = stepToShell(asRecord(steps[index]), `steps.${index}`, unsupportedFields)
    if (command) {
      commands.push(command)
    }
  }
  const setup = joinSetupScriptImportCommands(commands)
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

function stepToShell(
  step: Record<string, unknown> | null,
  prefix: string,
  unsupportedFields: string[]
): string {
  if (!step) {
    return ''
  }
  if (typeof step.uses === 'string') {
    // The workspace is already a checkout; other actions (toolchain installers) have no shell form.
    if (!/^actions\/checkout(@|$)/.test(step.uses.trim())) {
      pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.uses`)
    }
    return ''
  }
  const run = normalizeSetupScriptImportCommand(step.run)
  if (!run) {
    return ''
  }
  if (typeof step.shell === 'string' && !POSIX_SHELLS.has(step.shell.trim())) {
    pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.shell`)
    return ''
  }
  // Expressions and runner files only exist inside Actions, and sudo steps administer the throwaway
  // runner (e.g. freeing disk space); none of these belong on the user's machine.
  if (run.includes('${{') || RUNNER_ONLY_COMMAND.test(run)) {
    pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.run`)
    return ''
  }
  for (const field of ['if', 'env']) {
    if (step[field] !== undefined) {
      pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.${field}`)
    }
  }
  const workingDirectory = step['working-directory']
  if (workingDirectory === undefined) {
    return run
  }
  if (typeof workingDirectory !== 'string' || !SAFE_WORKING_DIRECTORY.test(workingDirectory)) {
    pushSetupScriptImportUnsupportedField(unsupportedFields, `${prefix}.working-directory`)
    return ''
  }
  // A subshell keeps the directory change scoped to this step, as Actions does.
  return `(\ncd ${workingDirectory} || exit 1\n${run}\n)`
}
