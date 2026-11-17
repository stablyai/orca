import { normalizeSetupScriptImportCommand } from './setup-script-import-command-limits'
import { asRecord } from './setup-script-import-parsers'
import { parseOrcaRunScripts, type OrcaRunScripts } from '../orca-yaml-run-actions'

// Conductor's run / run_mode / auto_run_after_setup map onto orca.yaml run actions. Orca's import
// flow saves a setup script, so run actions alone never make a candidate (the caller checks setup).

const RUN_SCRIPT_KEYS = ['run', 'run_mode', 'auto_run_after_setup'] as const
const MAX_RUN_ACTION_ARGS = 64

export type ConductorSettingsRunScripts = {
  runScripts: OrcaRunScripts
  /** settings.local.toml contributed to the imported run actions. */
  fromLocal: boolean
  /** Present but nothing importable (every action hidden or malformed). */
  unsupportedFields: string[]
}

/** Run actions from settings.toml, with settings.local.toml overriding key by key. */
export function conductorSettingsRunScripts(
  scripts: Record<string, unknown> | null,
  localScripts: Record<string, unknown> | null
): ConductorSettingsRunScripts {
  const runScripts = parseOrcaRunScripts({
    run: mergeConductorRunActions(scripts?.run, localScripts?.run),
    run_mode: localScripts?.run_mode ?? scripts?.run_mode,
    auto_run_after_setup: localScripts?.auto_run_after_setup ?? scripts?.auto_run_after_setup
  })
  const fromLocal =
    runScripts.run !== undefined && RUN_SCRIPT_KEYS.some((key) => localScripts?.[key] !== undefined)
  const unsupportedFields =
    !runScripts.run && (scripts?.run !== undefined || localScripts?.run !== undefined)
      ? ['scripts.run']
      : []
  return { runScripts, fromLocal, unsupportedFields }
}

/** Run actions from the legacy conductor.json (`scripts.run` plus root `runScriptMode`). */
export function conductorLegacyRunScripts(
  config: Record<string, unknown>,
  scripts: Record<string, unknown>
): OrcaRunScripts {
  return parseOrcaRunScripts({
    run: normalizeSetupScriptImportCommand(scripts.run),
    run_mode: config.runScriptMode
  })
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
            options: {
              ...asRecord(baseEntry.options),
              ...asRecord(localEntry.options)
            }
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
