import type { AppState } from '@/store/types'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  EMPTY_BROWSER_PAGES_BY_WORKSPACE,
  EMPTY_BROWSER_TABS_BY_WORKTREE,
  graphState
} from './graph-state'

export function getBrowserTabsByWorktree(state: AppState): AppState['browserTabsByWorktree'] {
  // Some callers/tests build partial pre-browser states; treat missing slices as empty.
  return state.browserTabsByWorktree ?? EMPTY_BROWSER_TABS_BY_WORKTREE
}

export function getBrowserPagesByWorkspace(state: AppState): AppState['browserPagesByWorkspace'] {
  return state.browserPagesByWorkspace ?? EMPTY_BROWSER_PAGES_BY_WORKSPACE
}

export function resolveRuntimeTerminalTitle(
  tab: Pick<
    TerminalTab,
    'customTitle' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedTitle' | 'title'
  >,
  generatedTitlesEnabled: boolean,
  liveTitle = tab.title
): string {
  return resolveTerminalTabTitle({ ...tab, title: liveTitle }, generatedTitlesEnabled, liveTitle)
}

export function buildRuntimeMobileTabsProjection(
  tabsByWorktree: AppState['tabsByWorktree']
): string {
  if (graphState.cachedTabsProjection?.source === tabsByWorktree) {
    return graphState.cachedTabsProjection.projection
  }

  const previousEntries = graphState.cachedTabsProjection?.entries
  const entries = new Map<
    string,
    {
      tabs: NonNullable<AppState['tabsByWorktree'][string]>
      worktreeIdJson: string
      projection: string
    }
  >()
  const parts: string[] = []
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const previous = previousEntries?.get(worktreeId)
    const entry =
      previous?.tabs === tabs
        ? previous
        : {
            tabs,
            worktreeIdJson: previous?.worktreeIdJson ?? JSON.stringify(worktreeId),
            projection: JSON.stringify(
              tabs.map((tab) => ({
                id: tab.id,
                title: tab.title,
                quickCommandLabel: tab.quickCommandLabel,
                aiVaultTitle: tab.aiVaultTitle,
                generatedTitle: tab.generatedTitle,
                customTitle: tab.customTitle,
                launchAgent: tab.launchAgent
              }))
            )
          }
    entries.set(worktreeId, entry)
    parts.push(`${entry.worktreeIdJson}:${entry.projection}`)
  }
  graphState.cachedTabsProjection = {
    source: tabsByWorktree,
    entries,
    projection: `{${parts.join(',')}}`
  }
  return graphState.cachedTabsProjection.projection
}

export function buildRuntimeMobileOpenFilesProjection(openFiles: AppState['openFiles']): string {
  return JSON.stringify(
    openFiles.map((file) => ({
      id: file.id,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      language: file.language,
      mode: file.mode,
      diffSource: file.diffSource,
      isDirty: file.isDirty,
      isUntitled: file.isUntitled,
      deleteUntouchedOnClose: file.deleteUntouchedOnClose,
      markdownPreviewSourceFileId: file.markdownPreviewSourceFileId
    }))
  )
}

export function buildRuntimeMobileBrowserProjection(state: AppState): string {
  const browserTabsByWorktree = getBrowserTabsByWorktree(state)
  const browserPagesByWorkspace = getBrowserPagesByWorkspace(state)
  return JSON.stringify({
    workspacesByWorktree: Object.fromEntries(
      Object.entries(browserTabsByWorktree).map(([worktreeId, workspaces]) => [
        worktreeId,
        workspaces.map((workspace) => ({
          id: workspace.id,
          activePageId: workspace.activePageId,
          title: workspace.title,
          url: workspace.url,
          loading: workspace.loading,
          canGoBack: workspace.canGoBack,
          canGoForward: workspace.canGoForward
        }))
      ])
    ),
    pagesByWorkspace: Object.fromEntries(
      Object.entries(browserPagesByWorkspace).map(([workspaceId, pages]) => [
        workspaceId,
        pages.map((page) => ({
          id: page.id,
          title: page.title,
          url: page.url,
          loading: page.loading,
          canGoBack: page.canGoBack,
          canGoForward: page.canGoForward
        }))
      ])
    )
  })
}

export function buildRuntimeMobileEditorDraftsProjection(
  editorDrafts: AppState['editorDrafts']
): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(editorDrafts).map(([fileId, content]) => [fileId, stableHashString(content)])
    )
  )
}

export function stableHashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `draft:${value.length}:${(hash >>> 0).toString(16)}`
}
