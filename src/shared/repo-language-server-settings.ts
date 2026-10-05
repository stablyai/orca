import { LANGUAGE_SERVER_IDS } from './language-server-types'
import type { LanguageServerId, RepoLanguageServerSettings } from './language-server-types'
import { LANGUAGE_SERVER_CATALOG } from './language-server-catalog'

const MAX_COMMAND_ARGS = 32
const MAX_ARG_LENGTH = 1024

function isLanguageServerId(value: string): value is LanguageServerId {
  return LANGUAGE_SERVER_IDS.some((id) => id === value)
}

function normalizeCommand(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_ARGS) {
    return null
  }
  const args: string[] = []
  for (const arg of value) {
    if (typeof arg !== 'string' || !arg || arg.length > MAX_ARG_LENGTH || arg.includes('\0')) {
      return null
    }
    args.push(arg)
  }
  return args
}

function normalizeEnabled(value: unknown): Partial<Record<LanguageServerId, boolean>> {
  const enabled: Partial<Record<LanguageServerId, boolean>> = {}
  if (typeof value !== 'object' || value === null) {
    return enabled
  }
  const flags = new Map<string, unknown>(Object.entries(value))
  const claimedLanguages = new Set<string>()
  // Why catalog order: one server per language, so ruby-lsp wins a tie with solargraph.
  for (const id of LANGUAGE_SERVER_IDS) {
    const flag = flags.get(id)
    if (typeof flag !== 'boolean') {
      continue
    }
    const languages = LANGUAGE_SERVER_CATALOG[id].languageIds
    const conflicts = flag && languages.some((language) => claimedLanguages.has(language))
    enabled[id] = flag && !conflicts
    if (enabled[id]) {
      languages.forEach((language) => claimedLanguages.add(language))
    }
  }
  return enabled
}

export function normalizeRepoLanguageServerSettings(
  value: unknown
): RepoLanguageServerSettings | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const enabled = normalizeEnabled('enabled' in value ? value.enabled : undefined)
  const command: Partial<Record<LanguageServerId, string[]>> = {}
  const commandInput = 'command' in value ? value.command : undefined
  if (typeof commandInput === 'object' && commandInput !== null) {
    for (const [id, raw] of Object.entries(commandInput)) {
      if (!isLanguageServerId(id) || LANGUAGE_SERVER_CATALOG[id].kind !== 'external') {
        continue
      }
      const args = normalizeCommand(raw)
      if (args) {
        command[id] = args
      }
    }
  }
  const result: RepoLanguageServerSettings = {}
  if (Object.keys(enabled).length > 0) {
    result.enabled = enabled
  }
  if (Object.keys(command).length > 0) {
    result.command = command
  }
  return result.enabled || result.command ? result : undefined
}
