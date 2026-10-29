import { editSessionSource, type SessionSourceEdit } from '../session-source-edits'
import type { BrowserPageConversionOrigin } from '../../../../shared/browser-workspace-types'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { getKnownExecutionHostIdForWorktree } from '../../lib/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '../../lib/worktree-runtime-owner-state'
import type { AppState } from '../types'

function preserveLocalUrlOrigin(
  origin: BrowserPageConversionOrigin | null | undefined
): BrowserPageConversionOrigin | null | undefined {
  return origin?.kind === 'url' && origin.browserRuntimeEnvironmentId === undefined
    ? { ...origin, browserRuntimeEnvironmentId: null }
    : origin
}

export function preserveConvertedSshBrowserPages(
  state: WorktreeRuntimeOwnerState & Pick<AppState, 'browserPagesByWorkspace'>,
  targetId: string,
  edit: SessionSourceEdit<
    WorktreeRuntimeOwnerState & Pick<AppState, 'browserPagesByWorkspace'>
  > = editSessionSource(state)
): AppState['browserPagesByWorkspace'] {
  const hostId = toSshExecutionHostId(targetId)
  for (const [workspaceId, pages] of Object.entries(state.browserPagesByWorkspace)) {
    let changed = false
    const next = pages.map((page) => {
      if (getKnownExecutionHostIdForWorktree(state, page.worktreeId) !== hostId) {
        return page
      }
      const localPage = !page.docLocation && page.browserRuntimeEnvironmentId === undefined
      const convertedFrom = preserveLocalUrlOrigin(page.convertedFrom)
      const convertedTo = preserveLocalUrlOrigin(page.convertedTo)
      if (!localPage && convertedFrom === page.convertedFrom && convertedTo === page.convertedTo) {
        return page
      }
      changed = true
      return {
        ...page,
        ...(localPage ? { browserRuntimeEnvironmentId: null } : {}),
        ...(convertedFrom !== page.convertedFrom ? { convertedFrom } : {}),
        ...(convertedTo !== page.convertedTo ? { convertedTo } : {})
      }
    })
    if (changed) {
      edit.set('browserPagesByWorkspace', workspaceId, next)
    }
  }
  return edit.read('browserPagesByWorkspace')
}
