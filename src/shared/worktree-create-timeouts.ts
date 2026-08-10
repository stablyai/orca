export type WorktreeCreateTimeouts = {
  refreshBaseRefMs: number
  addCheckoutMs: number
  registrationMs: number
  materializationMs: number
}

export type WorktreeCreateTimeoutOverrides = Partial<WorktreeCreateTimeouts>

export const WORKTREE_CREATE_TIMEOUT_DEFAULTS: Readonly<WorktreeCreateTimeouts> = {
  refreshBaseRefMs: 60_000,
  addCheckoutMs: 180_000,
  registrationMs: 30_000,
  materializationMs: 300_000
}

export const WORKTREE_CREATE_TIMEOUT_MIN_MS = 1_000
export const WORKTREE_CREATE_TIMEOUT_MAX_MS = 2 * 60 * 60 * 1_000
export const WORKTREE_CREATE_TRANSPORT_HEADROOM_MS = 30_000
const WORKTREE_CREATE_TIMEOUT_KEYS = [
  'refreshBaseRefMs',
  'addCheckoutMs',
  'registrationMs',
  'materializationMs'
] as const satisfies readonly (keyof WorktreeCreateTimeouts)[]

function normalizeTimeout(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.min(
    WORKTREE_CREATE_TIMEOUT_MAX_MS,
    Math.max(WORKTREE_CREATE_TIMEOUT_MIN_MS, Math.round(value))
  )
}

export function normalizeWorktreeCreateTimeoutOverrides(
  value: unknown
): WorktreeCreateTimeoutOverrides | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  const normalized: WorktreeCreateTimeoutOverrides = {}
  for (const key of WORKTREE_CREATE_TIMEOUT_KEYS) {
    const rawValue = candidate[key]
    if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
      normalized[key] = normalizeTimeout(rawValue, WORKTREE_CREATE_TIMEOUT_DEFAULTS[key])
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function normalizeWorktreeCreateTimeouts(
  value: unknown,
  fallback: WorktreeCreateTimeouts = { ...WORKTREE_CREATE_TIMEOUT_DEFAULTS }
): WorktreeCreateTimeouts {
  const normalizedFallback = Object.fromEntries(
    WORKTREE_CREATE_TIMEOUT_KEYS.map((key) => [
      key,
      normalizeTimeout(fallback[key], WORKTREE_CREATE_TIMEOUT_DEFAULTS[key])
    ])
  ) as WorktreeCreateTimeouts
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return Object.fromEntries(
    WORKTREE_CREATE_TIMEOUT_KEYS.map((key) => [
      key,
      normalizeTimeout(candidate[key], normalizedFallback[key])
    ])
  ) as WorktreeCreateTimeouts
}

export function resolveWorktreeCreateTimeouts({
  global,
  repo,
  request
}: {
  global?: WorktreeCreateTimeoutOverrides | null
  repo?: WorktreeCreateTimeoutOverrides | null
  request?: WorktreeCreateTimeoutOverrides | null
}): WorktreeCreateTimeouts {
  const globalTimeouts = normalizeWorktreeCreateTimeouts(global)
  const repoTimeouts = normalizeWorktreeCreateTimeouts(repo, globalTimeouts)
  return normalizeWorktreeCreateTimeouts(request, repoTimeouts)
}

export function getWorktreeCreateTransportTimeoutMs(timeouts: WorktreeCreateTimeouts): number {
  return (
    timeouts.refreshBaseRefMs +
    timeouts.addCheckoutMs +
    timeouts.registrationMs +
    timeouts.materializationMs +
    WORKTREE_CREATE_TRANSPORT_HEADROOM_MS
  )
}

export function getMaximumWorktreeCreateTransportTimeoutMs(): number {
  return (
    WORKTREE_CREATE_TIMEOUT_MAX_MS * WORKTREE_CREATE_TIMEOUT_KEYS.length +
    WORKTREE_CREATE_TRANSPORT_HEADROOM_MS
  )
}
