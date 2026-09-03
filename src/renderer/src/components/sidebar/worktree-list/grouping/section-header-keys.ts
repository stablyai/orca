import { LINEAGE_GROUP_PREFIX } from './group-keys'
import type { Row } from './row-types'

type CollapseAllState = 'collapse' | 'expand' | 'none'

export function collectSectionHeaderKeys(rows: readonly Row[]): string[] {
  const headerKeys: string[] = []
  for (const row of rows) {
    if (row.type === 'header') {
      headerKeys.push(row.key)
    }
  }
  return headerKeys
}

export function resolveCollapseAllState(
  headerKeys: readonly string[],
  collapsedGroups: ReadonlySet<string>
): CollapseAllState {
  if (headerKeys.length === 0) {
    return 'none'
  }
  return headerKeys.every((key) => collapsedGroups.has(key)) ? 'expand' : 'collapse'
}

export function collapseAllSectionKeys(
  collapsedGroups: ReadonlySet<string>,
  headerKeys: readonly string[]
): Set<string> {
  return new Set([...collapsedGroups, ...headerKeys])
}

// Why: headers nested under a collapsed parent are not in the row model, so expanding
// only the visible keys would leave them collapsed. Drop every section key instead and
// keep lineage (parent/child worktree) state untouched.
export function expandAllSectionKeys(collapsedGroups: ReadonlySet<string>): Set<string> {
  return new Set([...collapsedGroups].filter((key) => key.startsWith(LINEAGE_GROUP_PREFIX)))
}
