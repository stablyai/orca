import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import { normalizeSetupScriptImportCommand } from './setup-script-import-command-limits'
import {
  asRecord,
  collectPresentFields,
  parseJsonObject,
  parseTomlObject
} from './setup-script-import-parsers'
import { parseOrcaRunScripts, type OrcaRunScripts } from '../orca-yaml-run-actions'

const CONDUCTOR_SETTINGS_PATH = '.conductor/settings.toml'
const CONDUCTOR_LOCAL_SETTINGS_PATH = '.conductor/settings.local.toml'
const CONDUCTOR_LEGACY_CONFIG_PATH = 'conductor.json'

// Per-workspace env has no orca.yaml equivalent (secrets import reads its names separately).
const SETTINGS_UNSUPPORTED_ROOT_FIELDS = ['environment_variables', 'file_include_globs'] as const
const RUN_SCRIPT_KEYS = ['run', 'run_mode', 'auto_run_after_setup'] as const
const MAX_RUN_ACTION_ARGS = 64

export async function inspectConductorConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const [settingsContent, localSettingsContent] = await Promise.all([
    readFile(CONDUCTOR_SETTINGS_PATH),
    readFile(CONDUCTOR_LOCAL_SETTINGS_PATH)
  ])
  const settings = parseTomlObject(settingsContent)
  const localSettings = parseTomlObject(localSettingsContent)
  const candidate =
    settings || localSettings ? buildSettingsTomlCandidate(settings, localSettings) : null
  // Conductor ignores conductor.json once settings.toml exists, so mirror that precedence.
  return candidate ?? (settings ? null : inspectLegacyConductorJson(readFile))
}

function buildSettingsTomlCandidate(
  settings: Record<string, unknown> | null,
  localSettings: Record<string, unknown> | null
): SetupScriptImportCandidate | null {
  const scripts = asRecord(settings?.scripts)
  const localScripts = asRecord(localSettings?.scripts)
  // The machine-local file overrides the shared one key by key.
  const pickScript = (key: 'setup' | 'archive'): { value: string; fromLocal: boolean } => {
    const local = normalizeSetupScriptImportCommand(localScripts?.[key])
    if (local) {
      return { value: local, fromLocal: true }
    }
    return { value: normalizeSetupScriptImportCommand(scripts?.[key]), fromLocal: false }
  }
  // Orca's import flow saves a setup script, so run actions alone do not make a candidate.
  const setup = pickScript('setup')
  if (!setup.value) {
    return null
  }
  const archive = pickScript('archive')
  const runScripts = parseOrcaRunScripts({
    run: mergeConductorRunActions(scripts?.run, localScripts?.run),
    run_mode: localScripts?.run_mode ?? scripts?.run_mode,
    auto_run_after_setup: localScripts?.auto_run_after_setup ?? scripts?.auto_run_after_setup
  })
  const runFromLocal =
    runScripts.run !== undefined && RUN_SCRIPT_KEYS.some((key) => localScripts?.[key] !== undefined)

  const files: string[] = []
  if (settings) {
    files.push(CONDUCTOR_SETTINGS_PATH)
  }
  if (localSettings && (setup.fromLocal || archive.fromLocal || runFromLocal || !settings)) {
    files.push(CONDUCTOR_LOCAL_SETTINGS_PATH)
  }

  const unsupportedFields = new Set<string>()
  if (!runScripts.run && (scripts?.run !== undefined || localScripts?.run !== undefined)) {
    // Present but nothing importable (every action hidden or malformed).
    unsupportedFields.add('scripts.run')
  }
  for (const source of [settings, localSettings]) {
    if (source) {
      for (const field of collectPresentFields(source, SETTINGS_UNSUPPORTED_ROOT_FIELDS)) {
        unsupportedFields.add(field)
      }
    }
  }

  return {
    provider: 'conductor',
    label: 'Conductor',
    files,
    setup: setup.value,
    archive: archive.value || undefined,
    ...runScripts,
    unsupportedFields: [...unsupportedFields]
  }
}

async function inspectLegacyConductorJson(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const config = parseJsonObject(await readFile(CONDUCTOR_LEGACY_CONFIG_PATH))
  const scripts = asRecord(config?.scripts)
  if (!config || !scripts) {
    return null
  }

  const setup = normalizeSetupScriptImportCommand(scripts.setup)
  if (!setup) {
    return null
  }

  const runScripts: OrcaRunScripts = parseOrcaRunScripts({
    run: normalizeSetupScriptImportCommand(scripts.run),
    run_mode: config.runScriptMode
  })
  const unsupportedFields = collectPresentFields(config, ['enterpriseDataPrivacy'])
  if (normalizeSetupScriptImportCommand(scripts.teardown)) {
    unsupportedFields.push('scripts.teardown')
  }

  return {
    provider: 'conductor',
    label: 'Conductor',
    files: [CONDUCTOR_LEGACY_CONFIG_PATH],
    setup,
    archive: normalizeSetupScriptImportCommand(scripts.archive) || undefined,
    ...runScripts,
    unsupportedFields
  }
}

/**
 * settings.local.toml overrides an action field by field (so `hide = true` alone hides a shared
 * action); a legacy string on either side replaces the whole run value.
 */
function mergeConductorRunActions(base: unknown, local: unknown): unknown {
  const baseRecord = asRecord(base)
  const localRecord = asRecord(local)
  if (local !== undefined && !(baseRecord && localRecord)) {
    return toOrcaRunValue(local)
  }
  if (!baseRecord) {
    return toOrcaRunValue(base)
  }
  const merged: Record<string, unknown> = { ...baseRecord }
  for (const [id, entry] of Object.entries(localRecord ?? {})) {
    const baseEntry = asRecord(baseRecord[id])
    const localEntry = asRecord(entry)
    merged[id] =
      baseEntry && localEntry
        ? {
            ...baseEntry,
            ...localEntry,
            options: { ...asRecord(baseEntry.options), ...asRecord(localEntry.options) }
          }
        : entry
  }
  return toOrcaRunValue(merged)
}

/** Folds Conductor's `args` into the command, since orca.yaml actions carry one command string. */
function toOrcaRunValue(value: unknown): unknown {
  const record = asRecord(value)
  if (!record) {
    return value
  }
  const actions: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(record)) {
    const action = asRecord(entry)
    if (!action || typeof action.command !== 'string' || action.args === undefined) {
      actions[id] = entry
      continue
    }
    const { args, ...rest } = action
    const quoted = formatShellArgs(args)
    // Args we cannot read would leave a half-built command, so the action is dropped instead.
    actions[id] =
      quoted === null ? null : quoted ? { ...rest, command: `${action.command} ${quoted}` } : rest
  }
  return actions
}

/** '' when there are no args; null when they are not a string or a list of strings. */
function formatShellArgs(args: unknown): string | null {
  const list = typeof args === 'string' ? [args] : Array.isArray(args) ? args : null
  if (!list || list.length > MAX_RUN_ACTION_ARGS) {
    return null
  }
  if (!list.every((arg): arg is string => typeof arg === 'string')) {
    return null
  }
  return list.map(quoteShellArg).join(' ')
}

function quoteShellArg(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}
