import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import {
  joinSetupScriptImportCommands,
  normalizeSetupScriptImportCommand,
  pushSetupScriptImportUnsupportedField
} from './setup-script-import-command-limits'
import { SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS } from './setup-script-import-limits'
import { asRecord, collectPresentFields, parseJsoncObject } from './setup-script-import-parsers'

const DEVCONTAINER_CONFIG_PATHS = ['.devcontainer/devcontainer.json', '.devcontainer.json'] as const

// Creation-time lifecycle commands, in the order the spec runs them; together they are the one-time setup.
const SETUP_LIFECYCLE_COMMANDS = [
  'onCreateCommand',
  'updateContentCommand',
  'postCreateCommand'
] as const
// Host-side, per-start and per-attach commands have no per-workspace setup equivalent.
const UNSUPPORTED_FIELDS = [
  'initializeCommand',
  'postStartCommand',
  'postAttachCommand',
  'features'
] as const

const SHELL_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/

const VARIABLE_REWRITES: [RegExp, string][] = [
  [/\$\{(?:container|local)WorkspaceFolderBasename\}/g, '${ORCA_WORKSPACE_NAME}'],
  [/\$\{(?:container|local)WorkspaceFolder\}/g, '${ORCA_WORKTREE_PATH}'],
  [/\$\{(?:local|container)Env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}']
]

const UNREWRITTEN_VARIABLE =
  /\$\{(?:(?:local|container)Env:|devcontainerId\}|(?:container|local)WorkspaceFolder)/

export async function inspectDevcontainerConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  for (const configPath of DEVCONTAINER_CONFIG_PATHS) {
    const config = parseJsoncObject(await readFile(configPath))
    if (config) {
      return buildDevcontainerCandidate(configPath, config)
    }
  }
  return null
}

function buildDevcontainerCandidate(
  configPath: string,
  config: Record<string, unknown>
): SetupScriptImportCandidate | null {
  const unsupportedFields = collectPresentFields(config, UNSUPPORTED_FIELDS)
  const commands: string[] = []
  for (const field of SETUP_LIFECYCLE_COMMANDS) {
    commands.push(...lifecycleCommandToShell(config[field], field, unsupportedFields))
  }
  const setup = joinSetupScriptImportCommands(commands)
  if (!setup) {
    return null
  }
  return {
    provider: 'devcontainer',
    label: 'Dev Container',
    files: [configPath],
    setup,
    unsupportedFields
  }
}

/** String runs in a shell, array is argv, object is named commands the spec runs in parallel (we run them in order). */
function lifecycleCommandToShell(
  value: unknown,
  field: string,
  unsupportedFields: string[]
): string[] {
  if (value === undefined) {
    return []
  }
  const record = asRecord(value)
  if (!record) {
    const command = singleCommandToShell(value)
    if (!command) {
      pushSetupScriptImportUnsupportedField(unsupportedFields, field)
    }
    return command ? [command] : []
  }
  const keys = Object.keys(record)
  if (keys.length > SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS) {
    pushSetupScriptImportUnsupportedField(unsupportedFields, field)
    return []
  }
  const commands: string[] = []
  for (const key of keys) {
    const command = singleCommandToShell(record[key])
    if (command) {
      commands.push(command)
    } else {
      pushSetupScriptImportUnsupportedField(unsupportedFields, `${field}.${key}`)
    }
  }
  return commands
}

function singleCommandToShell(value: unknown): string {
  if (typeof value === 'string') {
    const rewritten = rewriteDevcontainerVariables(value)
    // Leftover spec variables (e.g. ${localEnv:X:default}) are a bash "bad substitution" error.
    if (UNREWRITTEN_VARIABLE.test(rewritten)) {
      return ''
    }
    return normalizeSetupScriptImportCommand(rewritten)
  }
  if (!Array.isArray(value) || value.length === 0) {
    return ''
  }
  // argv skips the shell; only join it when no argument would need quoting to survive one.
  const args: string[] = []
  for (const arg of value) {
    if (typeof arg !== 'string' || !SHELL_SAFE_ARG.test(arg)) {
      return ''
    }
    args.push(arg)
  }
  return normalizeSetupScriptImportCommand(args.join(' '))
}

function rewriteDevcontainerVariables(command: string): string {
  let rewritten = command
  for (const [pattern, replacement] of VARIABLE_REWRITES) {
    rewritten = rewritten.replace(pattern, replacement)
  }
  return rewritten
}
