import type {
  OrcaVmRecipe,
  OrcaVmRecipeLifecycleMode,
  OrcaVmRecipeTimeoutSeconds
} from './orca-yaml-hook-types'

const LIFECYCLE_MODES: readonly OrcaVmRecipeLifecycleMode[] = [
  'create',
  'suspend',
  'resume',
  'destroy'
]

// No default limit: a step only times out when its recipe sets timeoutSeconds, so recipes that
// work today (including legitimately slow image builds) never start failing. Create and destroy
// already have a user-facing cancel.
// Bounds typos (e.g. milliseconds) while still allowing slow image builds.
export const MAX_EPHEMERAL_VM_RECIPE_TIMEOUT_SECONDS = 24 * 60 * 60

export function getEphemeralVmRecipeTimeoutSeconds(
  recipe: Pick<OrcaVmRecipe, 'timeoutSeconds'>,
  mode: OrcaVmRecipeLifecycleMode
): number | undefined {
  return recipe.timeoutSeconds?.[mode]
}

/** Runtime records keep a recipe snapshot under a strict schema that current and older builds
 * share, so the snapshot never carries timeoutSeconds; lifecycle calls re-read the limit from
 * the repo's orca.yaml instead (see getRuntimeRecipeContext). */
export function toEphemeralVmRuntimeRecipeSnapshot(
  recipe: OrcaVmRecipe
): Omit<OrcaVmRecipe, 'timeoutSeconds'> {
  const { timeoutSeconds: _timeoutSeconds, ...snapshot } = recipe
  return snapshot
}

/** "15m", "1h 30m", "45s": compact enough to read the same in every locale. */
export function formatEphemeralVmRecipeTimeout(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const parts = [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    rest > 0 || seconds === 0 ? `${rest}s` : null
  ]
  return parts.filter((part): part is string => part !== null).join(' ')
}

export type EphemeralVmRecipeTimeoutParse =
  | { ok: true; timeoutSeconds?: OrcaVmRecipeTimeoutSeconds }
  | { ok: false; message: string }

/** Accepts one number for every mode, or a map keyed by create/suspend/resume/destroy. */
export function parseEphemeralVmRecipeTimeoutSeconds(
  value: unknown
): EphemeralVmRecipeTimeoutParse {
  if (value === undefined || value === null) {
    return { ok: true }
  }
  if (typeof value === 'number') {
    if (!isValidTimeoutSeconds(value)) {
      return { ok: false, message: invalidSecondsMessage('timeoutSeconds') }
    }
    return {
      ok: true,
      timeoutSeconds: Object.fromEntries(LIFECYCLE_MODES.map((mode) => [mode, value]))
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      message: 'timeoutSeconds must be a number or a map of create/suspend/resume/destroy.'
    }
  }
  const timeoutSeconds: OrcaVmRecipeTimeoutSeconds = {}
  for (const [key, seconds] of Object.entries(value)) {
    if (!isLifecycleMode(key)) {
      return {
        ok: false,
        message: `timeoutSeconds.${key} is not a lifecycle step; use create, suspend, resume, or destroy.`
      }
    }
    if (typeof seconds !== 'number' || !isValidTimeoutSeconds(seconds)) {
      return { ok: false, message: invalidSecondsMessage(`timeoutSeconds.${key}`) }
    }
    timeoutSeconds[key] = seconds
  }
  return Object.keys(timeoutSeconds).length > 0 ? { ok: true, timeoutSeconds } : { ok: true }
}

function isLifecycleMode(value: string): value is OrcaVmRecipeLifecycleMode {
  return LIFECYCLE_MODES.some((mode) => mode === value)
}

function isValidTimeoutSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_EPHEMERAL_VM_RECIPE_TIMEOUT_SECONDS
}

function invalidSecondsMessage(field: string): string {
  return `${field} must be a whole number of seconds from 1 to ${MAX_EPHEMERAL_VM_RECIPE_TIMEOUT_SECONDS}.`
}
