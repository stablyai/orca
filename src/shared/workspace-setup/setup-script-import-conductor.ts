import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import { normalizeSetupScriptImportCommand } from './setup-script-import-command-limits'
import {
  asRecord,
  collectPresentFields,
  parseJsonObject,
  parseTomlObject
} from './setup-script-import-parsers'

const CONDUCTOR_SETTINGS_PATH = '.conductor/settings.toml'
const CONDUCTOR_LOCAL_SETTINGS_PATH = '.conductor/settings.local.toml'
const CONDUCTOR_LEGACY_CONFIG_PATH = 'conductor.json'

// Run actions and per-workspace env have no Orca setup-script equivalent; list them as skipped.
const SETTINGS_UNSUPPORTED_SCRIPT_FIELDS = ['run', 'run_mode', 'auto_run_after_setup'] as const
const SETTINGS_UNSUPPORTED_ROOT_FIELDS = ['environment_variables', 'file_include_globs'] as const

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
  const setup = pickScript('setup')
  if (!setup.value) {
    return null
  }
  const archive = pickScript('archive')

  const files: string[] = []
  if (settings) {
    files.push(CONDUCTOR_SETTINGS_PATH)
  }
  if (localSettings && (setup.fromLocal || archive.fromLocal || !settings)) {
    files.push(CONDUCTOR_LOCAL_SETTINGS_PATH)
  }

  const unsupportedFields = new Set<string>()
  for (const [source, sourceScripts] of [
    [settings, scripts],
    [localSettings, localScripts]
  ] as const) {
    if (sourceScripts) {
      for (const field of collectPresentFields(
        sourceScripts,
        SETTINGS_UNSUPPORTED_SCRIPT_FIELDS,
        'scripts.'
      )) {
        unsupportedFields.add(field)
      }
    }
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

  const unsupportedFields = collectPresentFields(config, ['enterpriseDataPrivacy', 'runScriptMode'])
  for (const field of ['run', 'teardown'] as const) {
    if (normalizeSetupScriptImportCommand(scripts[field])) {
      unsupportedFields.push(`scripts.${field}`)
    }
  }

  return {
    provider: 'conductor',
    label: 'Conductor',
    files: [CONDUCTOR_LEGACY_CONFIG_PATH],
    setup,
    archive: normalizeSetupScriptImportCommand(scripts.archive) || undefined,
    unsupportedFields
  }
}
