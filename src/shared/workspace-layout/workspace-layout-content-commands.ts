import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'
import { applied, refuse, workspaceOrEmpty, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import { editorOpenFileId } from './workspace-layout-editor-open-file-id'
import { sameEditorFile } from './workspace-layout-editor-tab-file'
import { admitsInitialSurface } from './workspace-layout-initial-surface'
import type { LayoutEditorView } from './layout-editor-view'
import type {
  LayoutContentTab,
  LayoutEditorFile,
  LayoutTab,
  WorkspaceLayoutModel
} from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'
import { placeContentTab, promotePreviewTab } from './workspace-layout-tab-commands'

function contentTab(
  context: LayoutContext,
  fields: Pick<LayoutContentTab, 'kind' | 'entityId'> & Partial<LayoutContentTab>
): LayoutContentTab {
  return {
    id: context.mintId(),
    createdAt: context.now(),
    customTitle: null,
    color: null,
    ...fields
  }
}

/** Reuse the same file in the target group, updating its record and pinning nonpreview opens. Other split groups may keep their own tab for that file. */
export function openEditorTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openEditorTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  const workspace = model.workspaces[key]
  const fileId =
    command.fileId ??
    (command.file
      ? editorOpenFileId(workspace ?? { worktreeId: key, tabs: [] }, command.file)
      : undefined)
  if (!fileId) {
    return refuse('invalid_params')
  }
  const sameFile = (tab: LayoutTab): boolean =>
    tab.entityId === fileId && tab.kind === command.contentType
  const drawn = drawnTabOpen(model, key, command.tabId, sameFile, true)
  if (drawn) {
    // The same tab sent again: an open that rewrote its record or view (a conflict open) updates both.
    if (!drawn.ok || !command.tabId) {
      return drawn
    }
    const next = withEditorFile(drawn.model, key, command.file)
    return applied(withEditorView(next, key, command.tabId, command.view), drawn.result)
  }
  if (
    command.groupId &&
    workspace?.groups.length &&
    !workspace.groups.some((entry) => entry.id === command.groupId)
  ) {
    // Another group would put the tab where its sender did not.
    return refuse('group_not_found')
  }
  const target = withSendersGroup(model, key, command.groupId)
  const group =
    target.workspaces[key]?.groups.find((entry) => entry.id === command.groupId) ??
    target.workspaces[key]?.groups[0]
  const existing = workspace?.tabs.find(
    (tab) => sameFile(tab) && group?.tabOrder.includes(tab.id) === true
  )
  if (existing) {
    const pinned =
      existing.isPreview && !command.preview
        ? promotePreviewTab(model, {
            type: 'promotePreviewTab',
            workspace: key,
            tabId: existing.id
          })
        : applied(model)
    const next = withEditorFile(pinned.ok ? pinned.model : model, key, command.file)
    return applied(withEditorView(next, key, existing.id, command.view), { tabId: existing.id })
  }
  const tab = contentTab(context, {
    ...(command.tabId ? { id: command.tabId } : {}),
    ...(command.createdAt !== undefined ? { createdAt: command.createdAt } : {}),
    kind: command.contentType,
    entityId: fileId,
    ...(command.preview ? { isPreview: true } : {})
  })
  const placed = placeContentTab(target, key, tab, command, context)
  const next = withEditorFile(placed.model, key, command.file)
  return applied(withEditorView(next, key, tab.id, command.view), {
    tabId: tab.id,
    refused: placed.refused
  })
}

function withEditorFile(
  model: WorkspaceLayoutModel,
  key: string,
  file: LayoutEditorFile | undefined
): WorkspaceLayoutModel {
  if (!file) {
    return model
  }
  const workspace = model.workspaces[key]!
  const files = (workspace.editorFiles ?? []).filter((entry) => !sameEditorFile(entry, file))
  return withWorkspace(model, key, { ...workspace, editorFiles: [...files, file] })
}

function withEditorView(
  model: WorkspaceLayoutModel,
  key: string,
  tabId: string,
  view: LayoutEditorView | undefined
): WorkspaceLayoutModel {
  if (!view) {
    return model
  }
  const workspace = model.workspaces[key]!
  return withWorkspace(model, key, {
    ...workspace,
    editorViews: { ...workspace.editorViews, [tabId]: view }
  })
}

export function openBrowserTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openBrowserTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  // A host's tab is named by its page; a window names its tab-bar entry and record itself.
  const browserTabId = command.browserTabId ?? command.pageId ?? context.mintId()
  const tabId = command.tabId ?? browserTabId
  const pageId = command.pageId ?? context.mintId()
  // Only a window's open names its record; a host's is checked against its saved pages first.
  const taken = command.browserTabId
    ? takenBrowserTabIds(model, key, { tabId, browserTabId, pageId })
    : null
  if (taken) {
    return taken
  }
  const tab = contentTab(context, {
    kind: 'browser',
    id: tabId,
    entityId: browserTabId,
    ...(command.createdAt !== undefined ? { createdAt: command.createdAt } : {})
  })
  const next = placeContentTab(model, key, tab, command, context).model
  const workspace = next.workspaces[key]!
  const browserTab = {
    id: browserTabId,
    sessionProfileId: command.profileId ?? null,
    ...(command.sessionPartition ? { sessionPartition: command.sessionPartition } : {}),
    pageIds: [pageId],
    createdAt: command.browserCreatedAt ?? tab.createdAt
  }
  return applied(
    withWorkspace(next, key, {
      ...workspace,
      browserTabs: [...(workspace.browserTabs ?? []), browserTab]
    }),
    { tabId: tab.id, pageId }
  )
}

/** Resent drawn opens are idempotent; reject IDs held by another tab/page, and return null when free. */
function takenBrowserTabIds(
  model: WorkspaceLayoutModel,
  key: string,
  ids: { tabId: string; browserTabId: string; pageId: string }
): Applied | null {
  const own = model.workspaces[key]
  const record = own?.browserTabs?.find((entry) => entry.id === ids.browserTabId)
  if (
    record?.pageIds?.includes(ids.pageId) &&
    own?.tabs.some((tab) => tab.id === ids.tabId && tab.entityId === ids.browserTabId)
  ) {
    return applied(model, { tabId: ids.tabId, pageId: ids.pageId })
  }
  const workspaces = Object.values(model.workspaces)
  if (
    workspaces.some((workspace) =>
      workspace.tabs.some((tab) =>
        [tab.id, tab.entityId].some((id) => id === ids.tabId || id === ids.browserTabId)
      )
    )
  ) {
    return refuse('tab_exists')
  }
  return holdsBrowserPage(model, ids.pageId) ? refuse('page_exists') : null
}

export function holdsBrowserPage(model: WorkspaceLayoutModel, pageId: string): boolean {
  return Object.values(model.workspaces).some((workspace) =>
    workspace.browserTabs?.some((entry) => entry.pageIds?.includes(pageId))
  )
}

export function openAgentSessionTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openAgentSessionTab'>,
  context: LayoutContext
): Applied {
  if (command.initial && !admitsInitialSurface(model, command.workspace, command.initial)) {
    return applied(model)
  }
  const drawn = drawnTabOpen(
    model,
    command.workspace,
    command.tabId,
    (tab) => tab.kind === 'agent-session' && tab.entityId === command.sessionId,
    // Switch point: shipped builds still save a chat tab whose id another tab holds.
    ORCA_LAYOUT_OWNER_IS_MAIN
  )
  if (drawn) {
    return drawn
  }
  const tab = contentTab(context, {
    ...(command.tabId ? { id: command.tabId } : {}),
    ...(command.createdAt !== undefined ? { createdAt: command.createdAt } : {}),
    kind: 'agent-session',
    entityId: command.sessionId,
    agentSessionAgent: command.agent
  })
  const target = withSendersGroup(model, command.workspace, command.groupId)
  return applied(placeContentTab(target, command.workspace, tab, command, context).model, {
    tabId: tab.id
  })
}

/** Drawn tab IDs make resent or already-saved opens idempotent; refuseTaken rejects IDs held by another tab. Null proceeds with creation. */
export function drawnTabOpen(
  model: WorkspaceLayoutModel,
  key: string,
  tabId: string | undefined,
  sameContent: (tab: LayoutTab) => boolean,
  refuseTaken: boolean
): Applied | null {
  if (!tabId) {
    return null
  }
  const drawn = model.workspaces[key]?.tabs.find((tab) => tab.id === tabId)
  if (drawn && sameContent(drawn)) {
    return applied(model, { tabId: drawn.id })
  }
  const holds = Object.values(model.workspaces).some((entry) =>
    entry.tabs.some((tab) => tab.id === tabId)
  )
  return refuseTaken && holds ? refuse('tab_exists') : null
}

/** A workspace with no group takes the sender's, as the window keeps its emptied root group. */
export function withSendersGroup(
  model: WorkspaceLayoutModel,
  key: string,
  groupId: string | undefined
): WorkspaceLayoutModel {
  const workspace = model.workspaces[key]
  if (!groupId || workspace?.groups.length) {
    return model
  }
  return withWorkspace(model, key, {
    ...workspaceOrEmpty(model, key),
    groups: [{ id: groupId, tabOrder: [] }]
  })
}
