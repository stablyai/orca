import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { OpenFile } from '../../store/slices/editor'
import {
  toRuntimeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { ReadyEditorSurface, MirroredEditorTab, WebSessionTabsSyncState } from './state'
import type { WebSessionExistingTabIndex } from '../web-session-existing-tab-index'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { isReadyEditorTab } from './terminal-surfaces'
import {
  buildOwnedEditorFileId,
  isSameEditorOwner
} from '../../store/slices/editor/file-ids/editor-file-ids'
import { firstOpenFileByIdForWorktree } from './state-equality-files'
import {
  getKnownExecutionHostIdForWorktree,
  translateMirroredEditorRuntimeEnvironmentId
} from '@/lib/worktree-runtime-owner'

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
  executionHostId: ExecutionHostId
): Tab {
  return {
    id: hostTabId,
    entityId: file.id,
    groupId,
    worktreeId: file.worktreeId,
    executionHostId,
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

export function buildMirroredEditorTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  state: WebSessionTabsSyncState,
  worktreeOpenFiles: readonly OpenFile[],
  existingTabIndex: WebSessionExistingTabIndex,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  now: number,
  hasLocalDraft: (fileId: string) => boolean
): MirroredEditorTab[] {
  const readyEditorTabs = snapshot.tabs.filter(isReadyEditorTab)
  if (readyEditorTabs.length === 0) {
    return []
  }
  const runtimeEnvironmentId = translateMirroredEditorRuntimeEnvironmentId(
    state,
    snapshot.worktree,
    environmentId
  )
  const knownHost = getKnownExecutionHostIdForWorktree(
    { ...state, activeWorktreeId: null, activeWorkspaceExecutionHostId: null },
    snapshot.worktree
  )
  const executionHostId = runtimeEnvironmentId
    ? toRuntimeExecutionHostId(runtimeEnvironmentId)
    : parseExecutionHostId(knownHost)?.kind === 'ssh'
      ? knownHost
      : 'local'
  const ownerOpenFiles = worktreeOpenFiles.filter((file) =>
    isSameEditorOwner(file, snapshot.worktree, runtimeEnvironmentId)
  )
  const existingById = firstOpenFileByIdForWorktree(ownerOpenFiles)
  const occupiedUnifiedTabIds = new Set(
    (state.unifiedTabsByWorktree[snapshot.worktree] ?? []).map((tab) => tab.id)
  )
  const existingEditFilesByPath = new Map<string, OpenFile>()
  const existingPreviewSourceByPath = new Map<string, string>()
  let occupiedSourceIds: Set<string> | undefined
  const resolveNewSourceId = (sourcePath: string): string => {
    if (!occupiedSourceIds) {
      occupiedSourceIds = new Set()
      for (const file of state.openFiles) {
        if (!isSameEditorOwner(file, snapshot.worktree, runtimeEnvironmentId)) {
          occupiedSourceIds.add(file.id)
          if (file.markdownPreviewSourceFileId) {
            occupiedSourceIds.add(file.markdownPreviewSourceFileId)
          }
        }
      }
    }
    return occupiedSourceIds.has(sourcePath)
      ? buildOwnedEditorFileId(sourcePath, snapshot.worktree, runtimeEnvironmentId)
      : sourcePath
  }
  for (const file of ownerOpenFiles) {
    if (file.mode === 'edit' && !existingEditFilesByPath.has(file.filePath)) {
      existingEditFilesByPath.set(file.filePath, file)
    }
    if (file.markdownPreviewSourceFileId && !existingPreviewSourceByPath.has(file.filePath)) {
      existingPreviewSourceByPath.set(file.filePath, file.markdownPreviewSourceFileId)
    }
  }
  return readyEditorTabs.map((tab, index) => {
    const isPreview = tab.type === 'markdown' && tab.mode === 'markdown-preview'
    const sourcePath = isPreview ? tab.sourceFilePath : tab.filePath
    const sourceId =
      existingEditFilesByPath.get(sourcePath)?.id ??
      existingPreviewSourceByPath.get(tab.filePath) ??
      resolveNewSourceId(sourcePath)
    const fileId = isPreview ? `markdown-preview::${sourceId}` : sourceId
    const existingFile = existingById.get(fileId)
    const existingUnifiedTab = existingTabIndex.getEditorUnifiedTab(
      fileId,
      tab.id,
      executionHostId ?? 'local'
    )
    const unifiedTabId =
      existingUnifiedTab?.id ?? (occupiedUnifiedTabIds.has(tab.id) ? createBrowserUuid() : tab.id)
    occupiedUnifiedTabIds.add(unifiedTabId)
    const sourceFileId = isPreview ? sourceId : undefined
    const groupId = hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId
    // Why: the host publishes only its own store's flag and never learns of client edits, so
    // taking it verbatim would clear a client-dirty tab and the tab strip would then close it
    // with no unsaved-changes prompt while the draft still exists (#21392). A local draft is
    // the evidence the flag is the client's own; a dirty flag with no draft came from an
    // earlier snapshot and must keep following the host, e.g. after a host-side save.
    const keepsClientDirty = existingFile?.isDirty === true && hasLocalDraft(fileId)
    const file: OpenFile = {
      ...existingFile,
      id: fileId,
      filePath: tab.filePath,
      relativePath: tab.relativePath,
      worktreeId: snapshot.worktree,
      language: tab.language,
      isDirty: tab.isDirty || keepsClientDirty,
      runtimeEnvironmentId,
      mode: tab.type === 'markdown' ? tab.mode : 'edit',
      markdownPreviewSourceFileId: sourceFileId,
      // Why: marks this tab host-owned so a later snapshot that omits it can cull it; locally opened tabs lack this flag and survive.
      mirroredFromRuntimeSession: existingFile ? existingFile.mirroredFromRuntimeSession : true
    }
    return {
      file,
      hostTabId: tab.id,
      unifiedTab: buildEditorUnifiedTab(
        file,
        tab,
        unifiedTabId,
        existingUnifiedTab,
        tab.title.trim() || tab.relativePath || 'File',
        groupId,
        sortOffset + index,
        existingUnifiedTab?.createdAt ?? now + sortOffset + index,
        executionHostId ?? 'local'
      )
    }
  })
}
