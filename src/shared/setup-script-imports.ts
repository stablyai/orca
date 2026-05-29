import { inspectCodexEnvironmentConfig } from './setup-script-import-codex-environment'
import type { SetupScriptImportProvider } from './setup-script-import-providers'

export type SetupScriptImportCandidate = {
  provider: SetupScriptImportProvider
  label: string
  files: string[]
  setup: string
  archive?: string
  unsupportedFields?: string[]
}

export type SetupScriptImportFileRead = (relativePath: string) => Promise<string | null>

const SUPERSET_CONFIG_PATH = '.superset/config.json'
const SUPERSET_LOCAL_CONFIG_PATH = '.superset/config.local.json'
const CONDUCTOR_CONFIG_PATH = 'conductor.json'
const CMUX_CONFIG_PATHS = ['.cmux/cmux.json', 'cmux.json'] as const

export async function inspectSetupScriptImportCandidates(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate[]> {
  const candidates = await Promise.all([
    inspectSupersetConfig(readFile),
    inspectConductorConfig(readFile),
    inspectCodexEnvironmentConfig(readFile),
    inspectCmuxConfig(readFile)
  ])
  return candidates.filter(
    (candidate): candidate is SetupScriptImportCandidate => candidate != null
  )
}

async function inspectSupersetConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const config = parseJsonObject(await readFile(SUPERSET_CONFIG_PATH))
  if (!config) {
    return null
  }

  const localConfig = parseJsonObject(await readFile(SUPERSET_LOCAL_CONFIG_PATH))
  const unsupportedFields = collectUnsupportedFields(config, ['run', 'cwd'])
  const files = localConfig
    ? [SUPERSET_CONFIG_PATH, SUPERSET_LOCAL_CONFIG_PATH]
    : [SUPERSET_CONFIG_PATH]
  if (localConfig) {
    unsupportedFields.push(
      ...collectUnsupportedFields(localConfig, ['run', 'cwd']).map(
        (field) => `config.local.${field}`
      )
    )
  }

  const setup = resolveSupersetScriptValue(
    config.setup,
    localConfig?.setup,
    'setup',
    unsupportedFields
  )
  if (!setup) {
    return null
  }

  collectUnsupportedScriptObjectFields(config.setup, 'setup', unsupportedFields)
  collectUnsupportedScriptObjectFields(config.teardown, 'teardown', unsupportedFields)

  return {
    provider: 'superset',
    label: 'Superset',
    files,
    setup,
    archive:
      resolveSupersetScriptValue(
        config.teardown,
        localConfig?.teardown,
        'teardown',
        unsupportedFields
      ) || undefined,
    unsupportedFields
  }
}

async function inspectConductorConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const config = parseJsonObject(await readFile(CONDUCTOR_CONFIG_PATH))
  const scripts = asRecord(config?.scripts)
  if (!config || !scripts) {
    return null
  }

  const setup = normalizeCommandValue(scripts.setup)
  if (!setup) {
    return null
  }

  const unsupportedFields = collectUnsupportedFields(config, [
    'enterpriseDataPrivacy',
    'runScriptMode'
  ])
  for (const field of ['run', 'teardown'] as const) {
    if (normalizeCommandValue(scripts[field])) {
      unsupportedFields.push(`scripts.${field}`)
    }
  }

  return {
    provider: 'conductor',
    label: 'Conductor',
    files: [CONDUCTOR_CONFIG_PATH],
    setup,
    archive: normalizeCommandValue(scripts.archive) || undefined,
    unsupportedFields
  }
}

async function inspectCmuxConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  for (const configPath of CMUX_CONFIG_PATHS) {
    const config = parseJsonObject(await readFile(configPath))
    const candidate = config ? buildCmuxSetupCandidate(configPath, config) : null
    if (candidate) {
      return candidate
    }
  }
  return null
}

function parseJsonObject(content: string | null): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    return asRecord(JSON.parse(content))
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeCommandValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (!Array.isArray(value)) {
    return ''
  }
  const commands = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
  return commands.join('\n')
}

function resolveSupersetScriptValue(
  baseValue: unknown,
  localValue: unknown,
  key: 'setup' | 'teardown',
  unsupportedFields: string[]
): string {
  const baseCommand = normalizeCommandValue(baseValue)
  if (localValue === undefined) {
    return baseCommand
  }
  if (typeof localValue === 'string' || Array.isArray(localValue)) {
    return normalizeCommandValue(localValue)
  }

  const localRecord = asRecord(localValue)
  if (!localRecord) {
    unsupportedFields.push(`config.local.${key}`)
    return baseCommand
  }

  for (const field of Object.keys(localRecord)) {
    if (field !== 'before' && field !== 'after') {
      unsupportedFields.push(`config.local.${key}.${field}`)
    }
  }

  const beforeCommand = normalizeCommandValue(localRecord.before)
  const afterCommand = normalizeCommandValue(localRecord.after)
  return [beforeCommand, baseCommand, afterCommand].filter(Boolean).join('\n')
}

function buildCmuxSetupCandidate(
  configPath: string,
  config: Record<string, unknown>
): SetupScriptImportCandidate | null {
  const commands = Array.isArray(config.commands) ? config.commands : []
  for (let index = 0; index < commands.length; index++) {
    const command = asRecord(commands[index])
    if (!command || !isCmuxSetupCommand(command)) {
      continue
    }

    const setup = normalizeCommandValue(command.command)
    if (!setup) {
      continue
    }

    return {
      provider: 'cmux',
      label: 'cmux',
      files: [configPath],
      setup,
      unsupportedFields: collectUnsupportedCmuxCommandFields(command, index)
    }
  }
  return null
}

function isCmuxSetupCommand(command: Record<string, unknown>): boolean {
  if (typeof command.command !== 'string' || !command.command.trim()) {
    return false
  }

  const name = normalizeMatchText(command.name)
  const title = normalizeMatchText(command.title)
  const labels = [name, title].filter(Boolean)
  if (
    labels.some((label) =>
      ['setup', 'project setup', 'workspace setup', 'repository setup'].includes(label)
    )
  ) {
    return true
  }

  const keywords = getStringArray(command.keywords).map(normalizeMatchText)
  const hasSetupKeyword = keywords.some((keyword) =>
    ['setup', 'init', 'initialize', 'install'].includes(keyword)
  )
  if (!hasSetupKeyword) {
    return false
  }

  const commandText = normalizeMatchText(command.command)
  return labels.some((label) => label.includes('setup')) || /\bsetup\b/.test(commandText)
}

function normalizeMatchText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function collectUnsupportedCmuxCommandFields(
  command: Record<string, unknown>,
  commandIndex: number
): string[] {
  const supportedFields = new Set(['name', 'title', 'description', 'keywords', 'command'])
  return Object.keys(command)
    .filter((field) => !supportedFields.has(field))
    .map((field) => `commands.${commandIndex}.${field}`)
}

function collectUnsupportedFields(
  source: Record<string, unknown>,
  fieldNames: readonly string[]
): string[] {
  return fieldNames.filter((field) => source[field] !== undefined)
}

function collectUnsupportedScriptObjectFields(
  value: unknown,
  prefix: string,
  unsupportedFields: string[]
): void {
  const record = asRecord(value)
  if (!record) {
    return
  }
  for (const field of ['before', 'after'] as const) {
    if (record[field] !== undefined) {
      unsupportedFields.push(`${prefix}.${field}`)
    }
  }
}
