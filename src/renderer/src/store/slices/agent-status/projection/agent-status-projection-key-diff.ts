import type { AgentStatusProjectionState } from './agent-status-projection-state'

export const EMPTY_STRING_SET: ReadonlySet<string> = new Set()

export function collectOwnKeys(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined
): Set<string> {
  const keys = new Set<string>()
  if (left) {
    for (const key in left) {
      if (Object.hasOwn(left, key)) {
        keys.add(key)
      }
    }
  }
  if (right) {
    for (const key in right) {
      if (Object.hasOwn(right, key)) {
        keys.add(key)
      }
    }
  }
  return keys
}

/** Row keys whose applied remote context changed, including re-keyed chats and a first or last host. */
export function changedRemoteRowKeys(
  before: AgentStatusProjectionState['remoteRows'],
  after: AgentStatusProjectionState['remoteRows']
): ReadonlySet<string> {
  if (before === after) {
    return EMPTY_STRING_SET
  }
  let keys: Set<string> | undefined
  for (const key in before) {
    if (Object.hasOwn(before, key) && before[key] !== after[key]) {
      ;(keys ??= new Set()).add(key)
    }
  }
  for (const key in after) {
    if (Object.hasOwn(after, key) && !Object.hasOwn(before, key) && before[key] !== after[key]) {
      ;(keys ??= new Set()).add(key)
    }
  }
  return keys ?? EMPTY_STRING_SET
}
