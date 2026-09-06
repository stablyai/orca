import type { AppState } from '@/store/types'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { stableHashString } from './editor-draft-hash'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  EMPTY_BROWSER_PAGES_BY_WORKSPACE,
  EMPTY_BROWSER_TABS_BY_WORKTREE,
  graphState
} from './graph-state'
import type {
  BrowserPagesProjectionCacheEntry,
  BrowserWorkspacesProjectionCacheEntry,
  EditorDraftHashCache,
  EditorDraftHashCacheEntry,
  OpenFilesProjectionCacheEntry
} from './types'

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
    | 'customTitle'
    | 'quickCommandLabel'
    | 'aiVaultTitle'
    | 'generatedTitle'
    | 'title'
    | 'defaultTitle'
    | 'launchAgent'
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
  const cached = graphState.cachedOpenFilesProjection
  if (cached?.source === openFiles) {
    return cached.projection
  }

  // An isDirty flip replaces one file and re-spreads the array; reuse every other file.
  const previousEntries = cached?.entries
  const entries = new Map<string, OpenFilesProjectionCacheEntry>()
  const parts: string[] = []
  for (const file of openFiles) {
    const previous = previousEntries?.get(file.id)
    const entry =
      previous?.file === file
        ? previous
        : {
            file,
            projection: JSON.stringify({
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
            })
          }
    entries.set(file.id, entry)
    parts.push(entry.projection)
  }
  const projection = `[${parts.join(',')}]`
  graphState.cachedOpenFilesProjection = { source: openFiles, entries, projection }
  return projection
}

function buildBrowserWorkspacesProjection(
  browserTabsByWorktree: AppState['browserTabsByWorktree']
): string {
  const cached = graphState.cachedBrowserWorkspacesProjection
  if (cached?.source === browserTabsByWorktree) {
    return cached.projection
  }

  const previousEntries = cached?.entries
  const entries = new Map<string, BrowserWorkspacesProjectionCacheEntry>()
  const parts: string[] = []
  for (const [worktreeId, workspaces] of Object.entries(browserTabsByWorktree)) {
    const previous = previousEntries?.get(worktreeId)
    const entry =
      previous?.workspaces === workspaces
        ? previous
        : {
            workspaces,
            keyJson: previous?.keyJson ?? JSON.stringify(worktreeId),
            projection: JSON.stringify(
              workspaces.map((workspace) => ({
                id: workspace.id,
                activePageId: workspace.activePageId,
                title: workspace.title,
                url: workspace.url,
                loading: workspace.loading,
                canGoBack: workspace.canGoBack,
                canGoForward: workspace.canGoForward
              }))
            )
          }
    entries.set(worktreeId, entry)
    parts.push(`${entry.keyJson}:${entry.projection}`)
  }
  const projection = `{${parts.join(',')}}`
  graphState.cachedBrowserWorkspacesProjection = {
    source: browserTabsByWorktree,
    entries,
    projection
  }
  return projection
}

function buildBrowserPagesProjection(
  browserPagesByWorkspace: AppState['browserPagesByWorkspace']
): string {
  const cached = graphState.cachedBrowserPagesProjection
  if (cached?.source === browserPagesByWorkspace) {
    return cached.projection
  }

  const previousEntries = cached?.entries
  const entries = new Map<string, BrowserPagesProjectionCacheEntry>()
  const parts: string[] = []
  for (const [workspaceId, pages] of Object.entries(browserPagesByWorkspace)) {
    const previous = previousEntries?.get(workspaceId)
    const entry =
      previous?.pages === pages
        ? previous
        : {
            pages,
            keyJson: previous?.keyJson ?? JSON.stringify(workspaceId),
            projection: JSON.stringify(
              pages.map((page) => ({
                id: page.id,
                title: page.title,
                url: page.url,
                loading: page.loading,
                canGoBack: page.canGoBack,
                canGoForward: page.canGoForward
              }))
            )
          }
    entries.set(workspaceId, entry)
    parts.push(`${entry.keyJson}:${entry.projection}`)
  }
  const projection = `{${parts.join(',')}}`
  graphState.cachedBrowserPagesProjection = {
    source: browserPagesByWorkspace,
    entries,
    projection
  }
  return projection
}

export function buildRuntimeMobileBrowserProjection(state: AppState): string {
  // A title/url/loading tick replaces one worktree or workspace bucket; reuse the rest.
  return `{"workspacesByWorktree":${buildBrowserWorkspacesProjection(
    getBrowserTabsByWorktree(state)
  )},"pagesByWorkspace":${buildBrowserPagesProjection(getBrowserPagesByWorkspace(state))}}`
}

/**
 * Why memoized per file id: `setEditorDraft` fires on every Monaco keystroke and re-spreads
 * `editorDrafts`, so an unmemoized rebuild re-hashed every open dirty file's full text on the
 * input path. Only the typed file's draft string changes identity, so only it needs rehashing.
 */
function getEditorDraftHashCache(editorDrafts: AppState['editorDrafts']): EditorDraftHashCache {
  const cached = graphState.cachedEditorDraftHashes
  if (cached?.source === editorDrafts) {
    return cached
  }

  const previousEntries = cached?.entries
  const entries = new Map<string, EditorDraftHashCacheEntry>()
  const hashByFileId = new Map<string, string>()
  const parts: string[] = []
  for (const [fileId, content] of Object.entries(editorDrafts)) {
    const previous = previousEntries?.get(fileId)
    let entry: EditorDraftHashCacheEntry
    if (previous?.content === content) {
      entry = previous
    } else {
      const fileIdJson = previous?.fileIdJson ?? JSON.stringify(fileId)
      const hash = stableHashString(content)
      entry = { content, hash, fileIdJson, projection: `${fileIdJson}:${JSON.stringify(hash)}` }
    }
    entries.set(fileId, entry)
    hashByFileId.set(fileId, entry.hash)
    parts.push(entry.projection)
  }
  const next: EditorDraftHashCache = {
    source: editorDrafts,
    entries,
    hashByFileId,
    projection: `{${parts.join(',')}}`
  }
  graphState.cachedEditorDraftHashes = next
  return next
}

export function buildRuntimeMobileEditorDraftsProjection(
  editorDrafts: AppState['editorDrafts']
): string {
  return getEditorDraftHashCache(editorDrafts).projection
}

/** Per-file draft version stamps for the mobile session snapshot; shares the keystroke memo. */
export function getEditorDraftVersionByFileId(
  editorDrafts: AppState['editorDrafts']
): ReadonlyMap<string, string> {
  return getEditorDraftHashCache(editorDrafts).hashByFileId
}

export function resetRuntimeMobileSyncProjectionCachesForTests(): void {
  graphState.cachedTabsProjection = null
  graphState.cachedOpenFilesProjection = null
  graphState.cachedBrowserWorkspacesProjection = null
  graphState.cachedBrowserPagesProjection = null
  graphState.cachedEditorDraftHashes = null
}
