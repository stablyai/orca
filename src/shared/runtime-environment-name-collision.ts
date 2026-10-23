import { normalizeTypedName } from './typed-name-normalization'

/**
 * The saved server another server's name would be confused with.
 * Why: `--environment <name>` resolves names with normalizeTypedName and refuses a name two
 * servers share, so saving `Build` beside `build` makes both unreachable by name.
 */
export function findCollidingEnvironmentName<T extends { name: string }>(
  environments: readonly T[],
  name: string
): T | undefined {
  const key = normalizeTypedName(name)
  return environments.find((entry) => normalizeTypedName(entry.name) === key)
}
