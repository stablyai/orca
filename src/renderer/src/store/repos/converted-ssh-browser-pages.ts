import type { BrowserPageConversionOrigin } from '../../../../shared/browser-workspace-types'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import {
  getKnownExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '../../lib/worktree-runtime-owner'
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
  targetId: string
): AppState['browserPagesByWorkspace'] {
  const hostId = toSshExecutionHostId(targetId)
  let result = state.browserPagesByWorkspace
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
      if (result === state.browserPagesByWorkspace) {
        result = { ...result }
      }
      result[workspaceId] = next
    }
  }
  return result
}
