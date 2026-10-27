import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { OpenFile } from '../../store/slices/editor'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { ReadyEditorSurface, MirroredEditorTab } from './state'
import type { WebSessionExistingTabIndex } from '../web-session-existing-tab-index'
import { isReadyEditorTab } from './terminal-surfaces'
import { createMirroredEditorFileResolver } from './mirrored-editor-file-identity'
import { buildOwnedEditorFileId } from '../../store/slices/editor/file-ids/editor-file-ids'

export function buildTerminalUnifiedTab(
  tab: TerminalTab,
  groupId: string,
  environmentId: string,
  // Why: viewMode is host-tracked but the client's optimistic toggle must win during the echo window; callers pass the reconciled value.
  viewMode?: Tab['viewMode']
): Tab {
  return {
    id: tab.id,
    entityId: tab.id,
    groupId,
    worktreeId: tab.worktreeId,
    executionHostId: toRuntimeExecutionHostId(environmentId),
    contentType: 'terminal',
    label: tab.title,
    ...(tab.quickCommandLabel?.trim() ? { quickCommandLabel: tab.quickCommandLabel.trim() } : {}),
    ...(tab.generatedTitle?.trim() ? { generatedLabel: tab.generatedTitle.trim() } : {}),
    ...(tab.aiVaultTitle ? { aiVaultTitle: tab.aiVaultTitle } : {}),
    customLabel: tab.customTitle,
    color: tab.color,
    sortOrder: tab.sortOrder,
    createdAt: tab.createdAt,
    isPreview: false,
    isPinned: tab.isPinned === true,
    ...(viewMode ? { viewMode } : {})
  }
}

export function buildBrowserUnifiedTab(
  tab: BrowserWorkspace,
  hostTab: RuntimeMobileSessionBrowserTab,
  existingUnifiedTab: Tab | null,
  groupId: string,
  environmentId: string
): Tab {
  return {
    id: existingUnifiedTab?.id ?? hostTab.id,
    entityId: tab.id,
    groupId,
    worktreeId: tab.worktreeId,
    executionHostId: toRuntimeExecutionHostId(environmentId),
    contentType: 'browser',
    label: tab.title,
    customLabel: null,
    color: hostTab.color !== undefined ? hostTab.color : (existingUnifiedTab?.color ?? null),
    // Why: adoption must not reset the staged row's placement or manufacture/drop a focus visit.
    sortOrder: existingUnifiedTab?.sortOrder ?? tab.createdAt,
    createdAt: tab.createdAt,
    ...(existingUnifiedTab?.lastFocusedAt !== undefined
      ? { lastFocusedAt: existingUnifiedTab.lastFocusedAt }
      : {}),
    isPreview: false,
    isPinned:
      hostTab.isPinned !== undefined
        ? hostTab.isPinned === true
        : existingUnifiedTab?.isPinned === true
  }
}

export function buildEditorUnifiedTab(
  file: OpenFile,
  tab: ReadyEditorSurface,
  hostTabId: string,
  existingUnifiedTab: Tab | null,
  label: string,
  groupId: string,
  sortOrder: number,
  createdAt: number,
  environmentId: string
): Tab {
  return {
    id: hostTabId,
    entityId: file.id,
    groupId,
    worktreeId: file.worktreeId,
    executionHostId: toRuntimeExecutionHostId(environmentId),
    contentType: 'editor',
    label,
    customLabel: null,
    color: tab.color !== undefined ? tab.color : (existingUnifiedTab?.color ?? null),
    sortOrder,
    createdAt,
    isPreview: false,
    isPinned:
      tab.isPinned !== undefined ? tab.isPinned === true : existingUnifiedTab?.isPinned === true
  }
}

// Older peers can echo one file under IDs minted by several environments.
function mintedEnvironmentSegment(tab: ReadyEditorSurface, worktreeId: string): string | null {
  if (
    tab.type !== 'markdown' ||
    typeof tab.sourceFileId !== 'string' ||
    !tab.sourceFileId ||
    tab.sourceFileId === tab.sourceFilePath
  ) {
    return null
  }
  if (tab.id === tab.filePath) {
    return ''
  }
  const prefix = `editor:${encodeURIComponent(worktreeId)}:`
  const suffix = `:${encodeURIComponent(tab.filePath)}`
  if (
    !tab.id.startsWith(prefix) ||
    !tab.id.endsWith(suffix) ||
    tab.id.length <= prefix.length + suffix.length
  ) {
    return null
  }
  const segment = tab.id.slice(prefix.length, tab.id.length - suffix.length)
  let runtimeKey: string
  try {
    runtimeKey = decodeURIComponent(segment)
  } catch {
    return null
  }
  return buildOwnedEditorFileId(tab.filePath, worktreeId, runtimeKey) === tab.id ? segment : null
}

function dedupeReadyEditorTabsBySource(
  tabs: readonly ReadyEditorSurface[],
  worktreeId: string,
  preferredHostTabId: string | null
): ReadyEditorSurface[] {
  const bucketOf = (tab: ReadyEditorSurface): string =>
    JSON.stringify([
      worktreeId,
      tab.type === 'markdown' ? tab.mode : 'edit',
      tab.filePath,
      tab.type === 'markdown' ? tab.sourceFileId : null
    ])
  const rank = (tab: ReadyEditorSurface): number =>
    tab.id === preferredHostTabId ? 2 : tab.isActive ? 1 : 0
  const winnerByBucket = new Map<string, { segment: string; rank: number }>()
  for (const tab of tabs) {
    const segment = mintedEnvironmentSegment(tab, worktreeId)
    if (segment === null) {
      continue
    }
    const bucket = bucketOf(tab)
    const current = winnerByBucket.get(bucket)
    const tabRank = rank(tab)
    if (!current || tabRank > current.rank) {
      winnerByBucket.set(bucket, { segment, rank: tabRank })
    }
  }
  return tabs.filter((tab) => {
    const segment = mintedEnvironmentSegment(tab, worktreeId)
    return segment === null || segment === winnerByBucket.get(bucketOf(tab))?.segment
  })
}

export function buildMirroredEditorTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  openFiles: readonly OpenFile[],
  existingTabIndex: WebSessionExistingTabIndex,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  now: number,
  hasLocalDraft: (fileId: string) => boolean,
  preferredHostTabId: string | null = null
): MirroredEditorTab[] {
  const readyTabs = snapshot.tabs.filter(isReadyEditorTab)
  if (readyTabs.length === 0) {
    return []
  }
  const resolveFile = createMirroredEditorFileResolver(openFiles, snapshot.worktree, environmentId)
  // New split tabs share the retained file even when the host lists them before its original tab.
  for (const tab of readyTabs) {
    resolveFile(tab, existingTabIndex.getEditorUnifiedTabByHostId(tab.id))
  }
  const distinctTabs = dedupeReadyEditorTabsBySource(
    readyTabs,
    snapshot.worktree,
    preferredHostTabId
  )
  return distinctTabs.map((tab, index) => {
    const identity = resolveFile(tab, existingTabIndex.getEditorUnifiedTabByHostId(tab.id))
    const { fileId, existingFile, sourceFileId } = identity
    const existingUnifiedTab = existingTabIndex.getEditorUnifiedTab(fileId, tab.id)
    const groupId = hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId
    // Drafts prove client dirty ownership: host clean echoes must not bypass close prompts (#21392). Without a draft, dirty came from host and follows host saves.
    const keepsClientDirty = existingFile?.isDirty === true && hasLocalDraft(fileId)
    const file: OpenFile =
      identity.preservesOwner && existingFile
        ? existingFile
        : {
            ...existingFile,
            id: fileId,
            filePath: tab.filePath,
            relativePath: tab.relativePath,
            worktreeId: snapshot.worktree,
            language: tab.language,
            isDirty: tab.isDirty || keepsClientDirty,
            runtimeEnvironmentId: environmentId,
            mode: tab.type === 'markdown' ? tab.mode : 'edit',
            markdownPreviewSourceFileId: sourceFileId,
            // Why: marks this tab host-owned so a later snapshot that omits it can cull it; locally opened tabs lack this flag and survive.
            mirroredFromRuntimeSession: true
          }
    return {
      file,
      hostTabId: tab.id,
      unifiedTab: buildEditorUnifiedTab(
        file,
        tab,
        tab.id,
        existingUnifiedTab,
        tab.title.trim() || tab.relativePath || 'File',
        groupId,
        sortOffset + index,
        existingUnifiedTab?.createdAt ?? now + sortOffset + index,
        environmentId
      )
    }
  })
}
