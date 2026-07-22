import type { TabContentType, WorkspaceVisibleTabType } from '../../../../shared/types'

/** Pure twin of tabs.ts `toVisibleTabType` for unit tests. */
export function toVisibleTabTypeForTest(contentType: TabContentType): WorkspaceVisibleTabType {
  if (
    contentType === 'browser' ||
    contentType === 'terminal' ||
    contentType === 'simulator' ||
    contentType === 'collab-canvas'
  ) {
    return contentType
  }
  return 'editor'
}
