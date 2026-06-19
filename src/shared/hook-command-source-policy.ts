import type { HookCommandSourcePolicy } from './types'

export function normalizeHookCommandSourcePolicy(policy: unknown): HookCommandSourcePolicy {
  if (policy === 'local-only' || policy === 'run-both' || policy === 'shared-only') {
    return policy
  }

  // Why: old persisted settings may still contain the removed shared-first mode.
  // Treat any unknown value as the authoritative committed config policy.
  return 'shared-only'
}

export function resolveHookCommandSourcePolicy(
  policy: unknown,
  { hasLocalScript }: { hasLocalScript: boolean }
): HookCommandSourcePolicy {
  if (policy === 'local-only' || policy === 'run-both' || policy === 'shared-only') {
    return policy
  }

  if (policy === undefined && hasLocalScript) {
    return 'local-only'
  }

  return 'shared-only'
}
