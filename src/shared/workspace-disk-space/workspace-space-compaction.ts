import type { WorkspaceSpaceItem } from './workspace-space-types'

export const WORKSPACE_SPACE_MAX_TOP_LEVEL_ITEMS = 48

export function compactWorkspaceSpaceItems(items: WorkspaceSpaceItem[]): {
  topLevelItems: WorkspaceSpaceItem[]
  omittedTopLevelItemCount: number
  omittedTopLevelSizeBytes: number
} {
  const sorted = [...items].sort(
    (a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name)
  )
  if (sorted.length <= WORKSPACE_SPACE_MAX_TOP_LEVEL_ITEMS) {
    return {
      topLevelItems: sorted,
      omittedTopLevelItemCount: 0,
      omittedTopLevelSizeBytes: 0
    }
  }

  const visible = sorted.slice(0, WORKSPACE_SPACE_MAX_TOP_LEVEL_ITEMS - 1)
  let omittedSizeBytes = 0
  for (let index = visible.length; index < sorted.length; index += 1) {
    omittedSizeBytes += sorted[index].sizeBytes
  }
  const other: WorkspaceSpaceItem = {
    name: 'Other',
    path: '',
    kind: 'other',
    sizeBytes: omittedSizeBytes
  }

  return {
    topLevelItems: [...visible, other],
    omittedTopLevelItemCount: sorted.length - visible.length,
    omittedTopLevelSizeBytes: other.sizeBytes
  }
}
