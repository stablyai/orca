import type { TabContentType } from '../../../shared/tab-types'
import type { WorkspaceTabContentType } from './workspace-tab-palette-search'

export function isWorkspaceTabContentType(
  contentType: TabContentType
): contentType is WorkspaceTabContentType {
  return ['terminal', 'editor', 'diff', 'conflict-review', 'check-details'].includes(contentType)
}
