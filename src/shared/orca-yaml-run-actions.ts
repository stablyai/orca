import type { OrcaRunAction, OrcaRunActionHost, OrcaRunMode } from './orca-yaml-hook-types'
import {
  isOrcaYamlFieldWithinLimit,
  MAX_ORCA_YAML_COLLECTION_ENTRIES
} from './orca-yaml-file-limit'

/** The id of a run action written as one bare string (`scripts.run: pnpm dev`). */
export const LEGACY_RUN_ACTION_ID = 'run'

// Conductor ids allow letters, numbers, spaces and hyphens; dots and underscores are harmless extras.
export const ORCA_RUN_ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_RUN_ACTION_ENV_ENTRIES = 64

export type OrcaRunScripts = {
  run?: OrcaRunAction[]
  runMode?: OrcaRunMode
  autoRunAfterSetup?: boolean | string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isOrcaYamlFieldWithinLimit(value)) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

/** Control characters (newlines included) become spaces, so a name can't fake lines in approval text. */
function singleLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const text = Array.from(value, (char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : char
  })
    .join('')
    .trim()
  return text || undefined
}

export function parseOrcaRunMode(value: unknown): OrcaRunMode | undefined {
  return value === 'concurrent' || value === 'nonconcurrent' ? value : undefined
}

/** Hyphens read as spaces, as Conductor shows them. */
export function defaultRunActionName(id: string): string {
  const spaced = id.replace(/-/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A safe workspace-relative directory, or undefined; absolute and `..` paths never escape the checkout. */
export function normalizeRunActionCwd(value: unknown): string | undefined {
  const raw = asTrimmedString(value)
  if (!raw) {
    return undefined
  }
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const segments = normalized.split('/')
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.includes('..') ||
    segments.includes('')
  ) {
    return undefined
  }
  return normalized
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) {
    return undefined
  }
  const env: Record<string, string> = {}
  let count = 0
  for (const [key, raw] of Object.entries(record)) {
    if (count >= MAX_RUN_ACTION_ENV_ENTRIES) {
      break
    }
    if (!ENV_NAME_PATTERN.test(key)) {
      continue
    }
    const text =
      typeof raw === 'number' || typeof raw === 'boolean'
        ? String(raw)
        : typeof raw === 'string' && isOrcaYamlFieldWithinLimit(raw)
          ? raw
          : undefined
    if (text === undefined) {
      continue
    }
    env[key] = text
    count += 1
  }
  return count > 0 ? env : undefined
}

function normalizeHosts(value: unknown): OrcaRunActionHost[] | undefined {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
  if (!list) {
    return undefined
  }
  const hosts = new Set<OrcaRunActionHost>()
  for (const entry of list) {
    if (entry === 'local') {
      hosts.add('local')
    } else if (entry === 'remote' || entry === 'cloud') {
      // `cloud` is Conductor's spelling for a non-local workspace.
      hosts.add('remote')
    }
  }
  return hosts.size > 0 ? [...hosts] : undefined
}

function normalizeRunAction(id: string, value: unknown): OrcaRunAction | null {
  if (!ORCA_RUN_ACTION_ID_PATTERN.test(id)) {
    return null
  }
  const command = asTrimmedString(value)
  if (command) {
    return { id, name: defaultRunActionName(id), command }
  }
  const record = asRecord(value)
  if (!record || record.hide === true) {
    return null
  }
  const recordCommand = asTrimmedString(record.command)
  if (!recordCommand) {
    return null
  }
  const options = asRecord(record.options)
  const cwd = normalizeRunActionCwd(record.cwd ?? options?.cwd)
  const env = normalizeEnv(record.env)
  const runMode = parseOrcaRunMode(record.runMode ?? record.run_mode)
  const availableIn = normalizeHosts(record.availableIn ?? record.available_in)
  return {
    id,
    // One line: the name is shown in menus and in the approval text.
    name: singleLine(asTrimmedString(record.name)) ?? defaultRunActionName(id),
    command: recordCommand,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(record.default === true ? { default: true } : {}),
    ...(runMode ? { runMode } : {}),
    ...(availableIn ? { availableIn } : {})
  }
}

function normalizeRunActions(value: unknown): OrcaRunAction[] {
  const legacy = asTrimmedString(value)
  if (legacy) {
    return [{ id: LEGACY_RUN_ACTION_ID, name: 'Run', command: legacy }]
  }
  const record = asRecord(value)
  if (!record) {
    return []
  }
  const actions: OrcaRunAction[] = []
  for (const [id, entry] of Object.entries(record).slice(0, MAX_ORCA_YAML_COLLECTION_ENTRIES)) {
    const action = normalizeRunAction(id.trim(), entry)
    if (action) {
      actions.push(action)
    }
  }
  return actions
}

/** Reads `scripts.run`, `scripts.runMode` and `scripts.autoRunAfterSetup` (snake_case spellings too). */
export function parseOrcaRunScripts(scripts: Record<string, unknown> | null): OrcaRunScripts {
  if (!scripts) {
    return {}
  }
  const run = normalizeRunActions(scripts.run)
  const runMode = parseOrcaRunMode(scripts.runMode ?? scripts.run_mode)
  const autoRaw = scripts.autoRunAfterSetup ?? scripts.auto_run_after_setup
  const autoRunAfterSetup =
    autoRaw === true ? true : typeof autoRaw === 'string' ? asTrimmedString(autoRaw) : undefined
  return {
    ...(run.length > 0 ? { run } : {}),
    ...(runMode ? { runMode } : {}),
    ...(run.length > 0 && autoRunAfterSetup ? { autoRunAfterSetup } : {})
  }
}

/** The action the Run button starts: the one marked default, else the first listed. */
export function pickDefaultRunAction(
  actions: readonly OrcaRunAction[] | undefined
): OrcaRunAction | null {
  if (!actions || actions.length === 0) {
    return null
  }
  return actions.find((action) => action.default) ?? actions[0]
}

/** The action `autoRunAfterSetup` names, or null when it is off or names no action. */
export function pickAutoRunAction(scripts: OrcaRunScripts): OrcaRunAction | null {
  const { autoRunAfterSetup, run } = scripts
  if (!autoRunAfterSetup || !run) {
    return null
  }
  if (autoRunAfterSetup === true) {
    return pickDefaultRunAction(run)
  }
  return run.find((action) => action.id === autoRunAfterSetup) ?? null
}

export function effectiveRunMode(
  action: Pick<OrcaRunAction, 'runMode'>,
  scripts: Pick<OrcaRunScripts, 'runMode'>
): OrcaRunMode {
  return action.runMode ?? scripts.runMode ?? 'concurrent'
}

export function isRunActionAvailableOn(
  action: Pick<OrcaRunAction, 'availableIn'>,
  host: OrcaRunActionHost
): boolean {
  return !action.availableIn || action.availableIn.includes(host)
}

/** Stable text the user approves before any run action executes; any change re-prompts. */
export function formatRunActionsForTrust(actions: readonly OrcaRunAction[]): string {
  return actions
    .map((action) => {
      const lines = [`# ${action.name} (${action.id})`]
      if (action.cwd) {
        lines.push(`cd ${action.cwd}`)
      }
      for (const [key, value] of Object.entries(action.env ?? {})) {
        lines.push(`export ${key}=${JSON.stringify(value)}`)
      }
      lines.push(action.command)
      return lines.join('\n')
    })
    .join('\n\n')
}
