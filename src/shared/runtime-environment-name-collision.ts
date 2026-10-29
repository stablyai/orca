import { normalizeTypedName } from './typed-name-normalization'

/** Typed-name normalization makes Build/build collide; reject saves that would make both names unresolvable. */
export function findCollidingEnvironmentName<T extends { name: string }>(
  environments: readonly T[],
  name: string
): T | undefined {
  const key = normalizeTypedName(name)
  return environments.find((entry) => normalizeTypedName(entry.name) === key)
}
