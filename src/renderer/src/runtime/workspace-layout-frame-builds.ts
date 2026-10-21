// The two ways a workspace's store slices are built from its frame: the full build reads this
// window's view and facts back through its save and the Loader; the workspace build reads them
// from the store's records. Both run every restore builder over the named workspaces only, and
// lay the result over the store record by record (workspace-layout-frame-store-patch).

import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import { buildLayoutFrameSlices } from '@/store/workspace-layout-frame-slices'
import { buildLayoutFrameStorePatch } from '@/store/workspace-layout-frame-store-patch'
import type { HeldDrawnTabs } from '@/store/workspace-layout-frame-held-tabs'
import { layoutViewAndFactsOfStore } from '@/store/workspace-layout-frame-store-view'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { splitWorkspaceSessionByHost } from '@/lib/workspace-session-host-split'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type {
  DesktopLayoutView,
  LayoutContentFacts
} from '../../../shared/workspace-layout/workspace-layout-beside'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'

/** What the window's own commands hold as drawn; see buildLayoutFrameStorePatch. */
export type LayoutFrameBuildHolds = {
  keepsTerminalLayout: (tabId: string) => boolean
  newRowFields: (tabId: string) => Partial<TerminalTab> | null
  held: HeldDrawnTabs
}

export type LayoutFrameBuildPatch = Partial<AppState>

/** A bucket, not a host: the view read-back routes the workspaces a build skips here. */
const OTHER_WORKSPACES: ExecutionHostId = 'runtime:frame-sync-other-workspaces'

function patchFromSlices(
  state: AppState,
  cache: WorkspaceLayoutCache,
  keys: readonly string[],
  { view, facts }: { view: DesktopLayoutView; facts: LayoutContentFacts },
  holds: LayoutFrameBuildHolds
): LayoutFrameBuildPatch {
  const heldFiles = new Set(state.openFiles.map((file) => `${file.worktreeId}\0${file.id}`))
  const built = buildLayoutFrameSlices({
    layouts: Object.fromEntries(keys.map((key) => [key, cache[key]!])),
    facts,
    view,
    holdsEditorFile: (worktreeId, fileId) => heldFiles.has(`${worktreeId}\0${fileId}`)
  })
  return buildLayoutFrameStorePatch(
    state,
    built,
    keys,
    holds.keepsTerminalLayout,
    holds.newRowFields,
    holds.held
  )
}

/**
 * Startup, a reopened stream and a workspace new to the stream: the Loader also repairs the
 * legacy shapes a session restored from disk can hold, which the store's records then still have.
 */
export function fullLayoutFrameBuildPatch(
  state: AppState,
  cache: WorkspaceLayoutCache,
  keys: readonly string[],
  holds: LayoutFrameBuildHolds
): LayoutFrameBuildPatch {
  const built = new Set(keys)
  const own = splitWorkspaceSessionByHost(buildWorkspaceSessionPayload(state), (key) =>
    built.has(key) ? LOCAL_EXECUTION_HOST_ID : OTHER_WORKSPACES
  )[LOCAL_EXECUTION_HOST_ID]!
  const { facts, desktopView } = loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    own,
    nameBasedLoadContext()
  )
  return patchFromSlices(state, cache, keys, { view: desktopView, facts }, holds)
}

/** A workspace the store already shows from frames, whose records a frame changed. */
export function workspaceLayoutFrameBuildPatch(
  state: AppState,
  cache: WorkspaceLayoutCache,
  keys: readonly string[],
  holds: LayoutFrameBuildHolds
): LayoutFrameBuildPatch {
  return patchFromSlices(state, cache, keys, layoutViewAndFactsOfStore(state, keys), holds)
}
