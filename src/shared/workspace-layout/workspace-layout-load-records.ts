import {
  BROWSER_TAB_LAYOUT_FIELDS,
  BROWSER_TAB_WORKSPACE_FIELDS,
  EDITOR_DRAFT_FIELDS
} from './workspace-layout-beside'
import { childRecord, omitStoredFields, pickStoredFields } from './stored-record-fields'
import { editorFileKey, editorTabNamesFile } from './workspace-layout-editor-tab-file'
import type { WorkspaceLoadArgs } from './workspace-layout-load-types'
import type { LayoutBrowserTab, LayoutEditorFile, LayoutTab } from './workspace-layout-model'

/** Resolve disagreeing worktree IDs by record majority, falling back to the workspace key. */
export function resolveWorktreeId({ session, key }: WorkspaceLoadArgs): string {
  const named: { worktreeId: string }[] = [
    ...(session.tabsByWorktree?.[key] ?? []),
    ...(session.unifiedTabs?.[key] ?? []),
    ...(session.tabGroups?.[key] ?? []),
    ...(session.openFilesByWorktree?.[key] ?? []),
    ...(session.browserTabsByWorktree?.[key] ?? [])
  ]
  const counts = new Map<string, number>()
  for (const { worktreeId: id } of named) {
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  let worktreeId = key
  let most = 0
  for (const [candidate, count] of counts) {
    if (count > most) {
      worktreeId = candidate
      most = count
    }
  }
  return worktreeId
}

/** Conflicting tab/file preview flags become permanent so a disagreement cannot drop a draft. */
export function loadEditorFiles(
  args: WorkspaceLoadArgs,
  tabs: LayoutTab[],
  worktreeId: string
): LayoutEditorFile[] | undefined {
  const { session, key, view } = args
  const files = session.openFilesByWorktree?.[key]
  if (!files) {
    return undefined
  }
  const workspace = { worktreeId, tabs, editorFiles: files }
  return files.map((file) => {
    const draft = pickStoredFields(file, EDITOR_DRAFT_FIELDS)
    if (Object.keys(draft).length > 0) {
      childRecord(view.editorDrafts, key)[editorFileKey(file)] = draft
    }
    const fileTabs = tabs.filter(
      (tab) => tab.kind === 'editor' && editorTabNamesFile(workspace, tab.entityId, file)
    )
    // The file's copy is true when any of its tabs is preview (split groups share one file).
    const demoted = file.isPreview === true ? [] : fileTabs.filter((tab) => tab.isPreview)
    for (const tab of demoted) {
      delete tab.isPreview
    }
    return omitStoredFields(file, [...EDITOR_DRAFT_FIELDS, 'isPreview', 'worktreeId'])
  })
}

export function loadBrowserTabs(args: WorkspaceLoadArgs): LayoutBrowserTab[] | undefined {
  const { session, key, facts } = args
  return session.browserTabsByWorktree?.[key]?.map((tab) => {
    childRecord(facts.browserTabs, key)[tab.id] = omitStoredFields(tab, [
      ...BROWSER_TAB_LAYOUT_FIELDS,
      ...BROWSER_TAB_WORKSPACE_FIELDS
    ])
    return {
      id: tab.id,
      createdAt: tab.createdAt,
      ...pickStoredFields(tab, ['label', 'sessionProfileId', 'sessionPartition', 'pageIds'])
    }
  })
}
