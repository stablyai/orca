import {
  GIT_CREDENTIAL_GUARD_CONFIG_ENTRIES,
  GIT_CREDENTIAL_GUARD_WSLENV_SCALAR_KEYS,
  readValidGitConfigEnvCount
} from './git-credential-prompt-env'
import { addWslEnvKeys } from './wsl-env'

/**
 * Marks a terminal environment whose Git credential guard Orca applied, and
 * carries the pre-guard values so a child terminal the guard declines to guard
 * can undo exactly Orca's changes and nothing the user set themselves.
 */
export const TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV =
  'ORCA_INTERNAL_TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE'

const GUARD_CONFIG_VALUES = new Map<string, string>(GIT_CREDENTIAL_GUARD_CONFIG_ENTRIES)
const GUARD_CONFIG_SLOT_COUNT = GIT_CREDENTIAL_GUARD_CONFIG_ENTRIES.length
const GIT_CONFIG_PROTOCOL_KEY_RE = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/
const GIT_CONFIG_INDEXED_KEY_RE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/
const SCALAR_KEYS = [
  'GIT_TERMINAL_PROMPT',
  'GCM_INTERACTIVE',
  'GIT_ASKPASS',
  'SSH_ASKPASS'
] as const

/** Pre-guard values; `null` records that the variable was absent. */
type RestoreState = {
  v: 1
  env: Record<string, string | null>
  /** Index the guard appended its credential pair at, or null when it appended none. */
  configBase: number | null
}

export type GitCredentialGuardPreGuardState = {
  env: Record<string, string | null>
  configBase: number | null
}

function snapshot(env: Record<string, string>, key: string): string | null {
  return Object.hasOwn(env, key) ? (env[key] as string) : null
}

/** Capture the values the guard is about to overwrite. Must run before the guard. */
export function captureGitCredentialGuardPreGuardState(
  env: Record<string, string>
): GitCredentialGuardPreGuardState {
  const captured: Record<string, string | null> = {}
  for (const key of [...SCALAR_KEYS, 'WSLENV', 'GIT_CONFIG_COUNT']) {
    captured[key] = snapshot(env, key)
  }
  return { env: captured, configBase: readValidGitConfigEnvCount(env) }
}

/** Stamp a guarded environment with what Orca changed, so a child can undo it. */
export function recordGitCredentialGuardProvenance(
  env: Record<string, string>,
  pre: GitCredentialGuardPreGuardState,
  opts: { appendedConfig: boolean; forwardToWsl: boolean }
): void {
  const state: RestoreState = {
    v: 1,
    env: { ...pre.env },
    configBase: opts.appendedConfig ? pre.configBase : null
  }
  env[TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV] = JSON.stringify(state)
  if (opts.forwardToWsl) {
    // Why: the guard's own variables cross into WSL via WSLENV, so their provenance must cross too.
    addWslEnvKeys(env, [TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV])
  }
}

function readRestoreState(raw: string): RestoreState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const candidate = parsed as Partial<RestoreState>
  if (candidate.v !== 1 || typeof candidate.env !== 'object' || candidate.env === null) {
    return null
  }
  const entries = Object.entries(candidate.env).filter(
    ([, value]) => typeof value === 'string' || value === null
  ) as [string, string | null][]
  const configBase = candidate.configBase
  return {
    v: 1,
    env: Object.fromEntries(entries),
    // Why: a negative base is a position the guard cannot have appended at, and
    // would make slot 0 look guard-owned and delete a pair the user set.
    configBase:
      typeof configBase === 'number' && Number.isSafeInteger(configBase) && configBase >= 0
        ? configBase
        : null
  }
}

/** The value the guard writes for a key, given what was there before it ran. */
function guardOwnedValue(key: string, prior: string | null): string | null {
  if (key === 'GIT_TERMINAL_PROMPT') {
    return '0'
  }
  if (key === 'GCM_INTERACTIVE') {
    return 'never'
  }
  if (key === 'GIT_ASKPASS' || key === 'SSH_ASKPASS') {
    return prior ?? ''
  }
  return null
}

function restoreScalars(env: Record<string, string>, state: RestoreState): void {
  for (const key of SCALAR_KEYS) {
    if (!Object.hasOwn(state.env, key)) {
      continue
    }
    const prior = state.env[key] ?? null
    // Why: anything that no longer holds the guard's value was set after the guard ran; leave it.
    if (env[key] !== guardOwnedValue(key, prior)) {
      continue
    }
    if (prior === null) {
      delete env[key]
    } else {
      env[key] = prior
    }
  }
}

function restoreIndexedConfig(env: Record<string, string>, state: RestoreState): void {
  const base = state.configBase
  if (base === null) {
    return
  }
  const count = readValidGitConfigEnvCount(env)
  if (count === null) {
    // Why: the indexed protocol is positional, so a partial strip corrupts it. Leave an ambiguous set intact.
    return
  }
  const kept: [string, string][] = []
  for (let index = 0; index < count; index++) {
    const key = env[`GIT_CONFIG_KEY_${index}`] as string
    const value = env[`GIT_CONFIG_VALUE_${index}`] as string
    // Why: only the slots the guard appended; an identical-looking entry past them
    // was added inside the guarded pane and is the caller's to keep.
    const isGuardSlot = index >= base && index < base + GUARD_CONFIG_SLOT_COUNT
    if (isGuardSlot && GUARD_CONFIG_VALUES.get(key) === value) {
      continue
    }
    kept.push([key, value])
  }
  for (const key of Object.keys(env)) {
    if (GIT_CONFIG_INDEXED_KEY_RE.test(key)) {
      delete env[key]
    }
  }
  kept.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  if (kept.length === 0 && (state.env.GIT_CONFIG_COUNT ?? null) === null) {
    delete env.GIT_CONFIG_COUNT
    return
  }
  env.GIT_CONFIG_COUNT = String(kept.length)
}

function restoreWslEnv(env: Record<string, string>, state: RestoreState): void {
  if (!Object.hasOwn(state.env, 'WSLENV') || env.WSLENV === undefined) {
    return
  }
  const prior = state.env.WSLENV ?? null
  const priorNames = new Set(
    (prior ?? '')
      .split(':')
      .filter(Boolean)
      .map((t) => t.split('/')[0])
  )
  const kept = env.WSLENV.split(':')
    .filter(Boolean)
    .filter((token) => {
      const name = token.split('/')[0] ?? ''
      if (priorNames.has(name)) {
        return true
      }
      // Why: the guard never forwards the askpass names, so a WSLENV token it
      // never added is the user's even when it postdates the pre-guard snapshot.
      return !(
        name === TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV ||
        (GIT_CREDENTIAL_GUARD_WSLENV_SCALAR_KEYS as readonly string[]).includes(name) ||
        GIT_CONFIG_PROTOCOL_KEY_RE.test(name)
      )
    })
  if (kept.length === 0 && prior === null) {
    delete env.WSLENV
    return
  }
  env.WSLENV = kept.join(':')
}

/**
 * Undo an inherited Orca credential guard. Returns whether a guard was found.
 * Environments with no Orca marker are left untouched, so a user's own
 * `GIT_TERMINAL_PROMPT=0` survives.
 */
export function restoreUnguardedGitCredentialEnv(env: Record<string, string>): boolean {
  const raw = env[TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV]
  if (raw === undefined) {
    return false
  }
  delete env[TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV]
  const state = readRestoreState(raw)
  if (!state) {
    return false
  }
  restoreScalars(env, state)
  restoreIndexedConfig(env, state)
  restoreWslEnv(env, state)
  return true
}
