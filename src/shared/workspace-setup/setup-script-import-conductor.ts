import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import { normalizeSetupScriptImportCommand } from './setup-script-import-command-limits'
import {
  asRecord,
  collectPresentFields,
  parseJsonObject,
  parseTomlObject
} from './setup-script-import-parsers'
import {
  conductorLegacyRunScripts,
  conductorSettingsRunScripts
} from './setup-script-import-conductor-run'
import { withUbuntuSetup } from './setup-script-import-conductor-ubuntu'

const CONDUCTOR_SETTINGS_PATH = '.conductor/settings.toml'
const CONDUCTOR_LOCAL_SETTINGS_PATH = '.conductor/settings.local.toml'
const CONDUCTOR_LEGACY_CONFIG_PATH = 'conductor.json'

// Per-workspace env has no orca.yaml equivalent (secrets import reads its names separately).
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
  return withUbuntuSetup(
    candidate ?? (settings ? null : await inspectLegacyConductorJson(readFile)),
    readFile
  )
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
  const run = conductorSettingsRunScripts(scripts, localScripts)

  const files: string[] = []
  if (settings) {
    files.push(CONDUCTOR_SETTINGS_PATH)
  }
  if (localSettings && (setup.fromLocal || archive.fromLocal || run.fromLocal || !settings)) {
    files.push(CONDUCTOR_LOCAL_SETTINGS_PATH)
  }

  const unsupportedFields = new Set<string>(run.unsupportedFields)
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
    ...run.runScripts,
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

  const runScripts = conductorLegacyRunScripts(config, scripts)
  const unsupportedFields = collectPresentFields(config, ['enterpriseDataPrivacy'])
  for (const field of ['teardown'] as const) {
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
    ...runScripts,
    unsupportedFields
  }
}
