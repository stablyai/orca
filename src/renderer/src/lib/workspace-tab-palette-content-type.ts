import type { TabContentType } from '../../../shared/tab-types'
import type { WorkspaceTabContentType } from './workspace-tab-palette-search'

// Why exclusion: browser and simulator tabs have their own palette rows; every other tab kind is a
// workspace tab, so a new kind reaches the entry builder, which then needs a branch to title it.
export function isWorkspaceTabContentType(
  contentType: TabContentType
): contentType is WorkspaceTabContentType {
  return contentType !== 'browser' && contentType !== 'simulator'
}
