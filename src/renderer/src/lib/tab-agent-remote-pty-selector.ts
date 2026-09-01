import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

/** Checks both PTY projections without allocating a dedupe set on each store notification. */
export function hasRemoteRuntimePtyForTab(
  tabPtyIds: readonly string[] | undefined,
  leafPtyIdsById: Readonly<Record<string, string>> | undefined
): boolean {
  if (tabPtyIds?.some((ptyId) => parseRemoteRuntimePtyId(ptyId) !== null)) {
    return true
  }
  if (!leafPtyIdsById) {
    return false
  }
  for (const leafId in leafPtyIdsById) {
    if (
      Object.hasOwn(leafPtyIdsById, leafId) &&
      parseRemoteRuntimePtyId(leafPtyIdsById[leafId]!) !== null
    ) {
      return true
    }
  }
  return false
}
