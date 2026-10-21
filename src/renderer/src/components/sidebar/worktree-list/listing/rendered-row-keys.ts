import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { getRenderRowSidebarKey } from '../navigation/render-row-lookup'

/** Every key the rendered rows answer to, for reveal and scroll lookups. */
export function collectRenderedSidebarRowKeys(sectionRows: readonly HostSectionRow[]): Set<string> {
  const keys = new Set<string>()
  for (const row of sectionRows) {
    // Why the shared lookup: reveal matches rows by the same key, so the two cannot drift.
    const key = getRenderRowSidebarKey(row)
    if (key !== null) {
      keys.add(key)
    }
    if (row.type === 'folder-workspace') {
      // Why: reveal requests name a folder row by host identity or bare key, not its section-scoped key.
      keys.add(getFolderWorkspaceHostIdentity(row.folderWorkspace))
      keys.add(folderWorkspaceKey(row.folderWorkspace.id))
    }
  }
  return keys
}
