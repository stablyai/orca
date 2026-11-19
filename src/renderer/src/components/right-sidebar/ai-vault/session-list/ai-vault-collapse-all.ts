import { useCallback, useMemo } from 'react'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'

export type AiVaultCollapseAll = {
  /** Every group with a header is collapsed, so the toggle expands them all. */
  allCollapsed: boolean
  toggle: () => void
}

/** Keys of the groups that show a header; search results list as one headerless group. */
function aiVaultCollapsibleGroupKeys(groups: readonly AiVaultSessionListGroup[]): string[] {
  return groups.flatMap((group) => (group.label === null ? [] : [group.key]))
}

/** Collapses every listed group, or expands them all once all are collapsed; null with no headers. */
export function useAiVaultCollapseAll(
  groups: readonly AiVaultSessionListGroup[],
  collapsedGroups: ReadonlySet<string>,
  setGroupsCollapsed: (keys: readonly string[], collapsed: boolean) => void
): AiVaultCollapseAll | null {
  const keys = useMemo(() => aiVaultCollapsibleGroupKeys(groups), [groups])
  const allCollapsed = keys.length > 0 && keys.every((key) => collapsedGroups.has(key))
  const toggle = useCallback(
    () => setGroupsCollapsed(keys, !allCollapsed),
    [allCollapsed, keys, setGroupsCollapsed]
  )
  return keys.length === 0 ? null : { allCollapsed, toggle }
}
