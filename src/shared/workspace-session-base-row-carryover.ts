import type { BrowserWorkspace } from './browser-workspace-types'
import type { Tab } from './tab-types'
import type { PersistedOpenFile, WorkspaceSessionState } from './workspace-session-state-types'
import { newestHostEvidenceAt, type CarriedSurface } from './workspace-session-base-tab-carryover'

/**
 * Base editor files and browser workspaces kept when a populated host row replaces the base's.
 *
 * The rule `baseTabsTheHostNeverListed` applies to terminal tabs, carried over to the other rows a
 * host-owned workspace replaces wholesale: the host copy wins every entry it lists, and a base-only
 * entry survives only when dropping it would lose something nothing else restores.
 *  - An editor file survives when it holds an unsaved draft. `RemoteWorkspaceSession` carries
 *    terminal fields only, so a dropped `dirtyDraftContent` is gone for good. A clean file is still
 *    on disk, and a base-only one is most often a file the owning copy has closed since.
 *  - A browser workspace survives under the terminal tabs' time bound: created after the host's
 *    newest evidence for the workspace. Legacy residue is older than the host's rows; a browser
 *    opened while the host was unresolved is not.
 *
 * Not merged, by design: the `active*` pointers and `tabGroupLayouts` each name one choice and
 * follow the row that won; `clientHostedBrowserPagesByWorktree` is authored by the runtime alone, so
 * the host copy is the only one; `browserPagesByWorkspace` and `markdownFrontmatterVisible` are
 * keyed per entity and only ever gap-filled, so a carried entry's own rows are already kept.
 */
/** Folds the surviving base entries into the rows adoption replaced, and returns the unified
 *  surfaces they need. */
export function carryBaseEntriesIntoHostRows(
  next: WorkspaceSessionState,
  base: WorkspaceSessionState,
  host: WorkspaceSessionState
): Map<string, CarriedSurface[]> {
  const surfacesByKey = new Map<string, CarriedSurface[]>()
  const addSurface = (key: string, surface: CarriedSurface): void => {
    surfacesByKey.set(key, [...(surfacesByKey.get(key) ?? []), surface])
  }

  const replacedFileRows = replacedRowKeys(next, base, host, 'openFilesByWorktree')
  if (replacedFileRows.length > 0) {
    const openFilesByWorktree = { ...next.openFilesByWorktree }
    for (const key of replacedFileRows) {
      const hostFiles = openFilesByWorktree[key] ?? []
      const carried = unsavedBaseFiles(base.openFilesByWorktree?.[key], hostFiles)
      if (carried.length === 0) {
        continue
      }
      openFilesByWorktree[key] = [...hostFiles, ...carried]
      for (const file of carried) {
        addSurface(key, {
          contentType: 'editor',
          entityId: file.filePath,
          build: (placement) => editorEntryFor(file, placement)
        })
      }
    }
    next.openFilesByWorktree = openFilesByWorktree
  }

  const replacedBrowserRows = replacedRowKeys(next, base, host, 'browserTabsByWorktree')
  if (replacedBrowserRows.length > 0) {
    const browserTabsByWorktree = { ...next.browserTabsByWorktree }
    for (const key of replacedBrowserRows) {
      const hostBrowsers = browserTabsByWorktree[key] ?? []
      const carried = newerBaseBrowsers(base.browserTabsByWorktree?.[key], hostBrowsers, host, key)
      if (carried.length === 0) {
        continue
      }
      browserTabsByWorktree[key] = [...hostBrowsers, ...carried]
      // No `build`: browser hydration creates the entry for a workspace the unified row lacks.
      for (const browser of carried) {
        addSurface(key, { contentType: 'browser', entityId: browser.id })
      }
    }
    next.browserTabsByWorktree = browserTabsByWorktree
  }
  return surfacesByKey
}

/**
 * Keys whose base row adoption replaced with the host's. `adoptRecord` writes the host's row object
 * itself, so a row `next` shares with the host where the base held a different one was replaced —
 * a gap-fill has no base row, and a declined or contested key keeps the base's object.
 */
function replacedRowKeys(
  next: WorkspaceSessionState,
  base: WorkspaceSessionState,
  host: WorkspaceSessionState,
  field: 'openFilesByWorktree' | 'browserTabsByWorktree'
): string[] {
  const baseRows = base[field] ?? {}
  return Object.entries(host[field] ?? {})
    .filter(
      ([key, hostRow]) =>
        Object.hasOwn(baseRows, key) && baseRows[key] !== hostRow && next[field]?.[key] === hostRow
    )
    .map(([key]) => key)
}

/** Hydration keys a restored file by path within its runtime, so the same pair is one file. */
function openFileIdentity(file: PersistedOpenFile): string {
  return `${file.runtimeEnvironmentId ?? ''}\u0000${file.filePath}`
}

function unsavedBaseFiles(
  baseFiles: readonly PersistedOpenFile[] | undefined,
  hostFiles: readonly PersistedOpenFile[]
): PersistedOpenFile[] {
  const listed = new Set(hostFiles.map(openFileIdentity))
  // Why read-only files are excluded: hydration discards their drafts, so there is nothing to keep.
  return (baseFiles ?? []).filter(
    (file) =>
      file.dirtyDraftContent !== undefined &&
      file.readOnly !== true &&
      !listed.has(openFileIdentity(file))
  )
}

function newerBaseBrowsers(
  baseBrowsers: readonly BrowserWorkspace[] | undefined,
  hostBrowsers: readonly BrowserWorkspace[],
  host: WorkspaceSessionState,
  key: string
): BrowserWorkspace[] {
  if (!baseBrowsers || baseBrowsers.length === 0) {
    return []
  }
  const listed = new Set(hostBrowsers.map((browser) => browser.id))
  let hostSeenUntil = newestHostEvidenceAt(host.tabsByWorktree?.[key] ?? [], host, key)
  for (const browser of hostBrowsers) {
    hostSeenUntil = Math.max(hostSeenUntil, browser.createdAt)
  }
  return baseBrowsers.filter(
    (browser) => !listed.has(browser.id) && browser.createdAt > hostSeenUntil
  )
}

/** Built the way legacy hydration builds an editor entry, which is what a carried file lacked. */
function editorEntryFor(
  file: PersistedOpenFile,
  { groupId, sortOrder }: { groupId: string; sortOrder: number }
): Tab {
  return {
    id: file.filePath,
    entityId: file.filePath,
    groupId,
    worktreeId: file.worktreeId,
    contentType: 'editor',
    label: file.relativePath,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: Date.now(),
    isPreview: file.isPreview,
    isPinned: false
  }
}
