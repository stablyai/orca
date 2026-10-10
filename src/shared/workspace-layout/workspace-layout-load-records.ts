// A workspace's own id and its editor and browser records, each fact taken once.

import {
  BROWSER_TAB_LAYOUT_FIELDS,
  BROWSER_TAB_WORKSPACE_FIELDS,
  EDITOR_DRAFT_FIELDS
} from './workspace-layout-beside'
import { childRecord, omitStoredFields, pickStoredFields } from './stored-record-fields'
import type { WorkspaceLoadArgs } from './workspace-layout-load-types'
import type { LayoutBrowserTab, LayoutEditorFile, LayoutTab } from './workspace-layout-model'

/**
 * Every record of a workspace names its worktree id. Stored data can disagree: the value most
 * records name is kept (the key when none names one).
 */
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

/**
 * Preview is one fact per editor tab, stored on both the tab and its file. Where the two disagree
 * the tab is permanent, which can never drop a draft.
 */
export function loadEditorFiles(
  args: WorkspaceLoadArgs,
  tabs: LayoutTab[]
): LayoutEditorFile[] | undefined {
  const { session, key, view } = args
  const files = session.openFilesByWorktree?.[key]
  if (!files) {
    return undefined
  }
  return files.map((file) => {
    const draft = pickStoredFields(file, EDITOR_DRAFT_FIELDS)
    if (Object.keys(draft).length > 0) {
      childRecord(view.editorDrafts, key)[file.filePath] = draft
    }
    const fileTabs = tabs.filter((tab) => tab.kind === 'editor' && tab.entityId === file.filePath)
    // The file's copy is true when any of its tabs is preview (split groups share one file).
    const demoted = file.isPreview === true ? [] : fileTabs.filter((tab) => tab.isPreview)
    for (const tab of demoted) {
      // Loaded tabs are fresh copies, so this touches no stored data.
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
