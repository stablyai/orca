// Rebuild compatible window records from published layout using main’s Serializer. Missing incarnation/sleeping/closed-tab facts remain absent.

import type { LayoutEditorView } from './layout-editor-view'
import { pickStoredFields } from './stored-record-fields'
import type {
  LayoutLeaf,
  LayoutTab,
  WorkspaceLayout,
  WorkspaceLayoutModel
} from './workspace-layout-model'
import type {
  PublishedTab,
  PublishedTerminal,
  PublishedWorkspaceLayout
} from './workspace-layout-published'
import type { ExecutionHostId } from '../execution-host'

function layoutTab(tab: PublishedTab): LayoutTab {
  const fields = {
    id: tab.id,
    entityId: tab.entityId,
    createdAt: tab.createdAt,
    customTitle: tab.customTitle,
    color: tab.color,
    ...pickStoredFields(tab, [
      'generatedTitle',
      'aiVaultTitle',
      'quickCommandLabel',
      'isPinned',
      'viewMode',
      'isPreview',
      'agentSessionAgent'
    ])
  }
  if (tab.kind !== 'terminal') {
    return { ...fields, kind: tab.kind }
  }
  const terminal: Partial<PublishedTerminal> = tab.terminal ?? {}
  return {
    ...fields,
    kind: 'terminal',
    terminal: pickStoredFields(terminal, [
      'defaultTitle',
      'shellOverride',
      'forceHostRuntime',
      'startupCwd',
      'launchAgent'
    ]),
    panes: {
      root: terminal.root ?? null,
      ...pickStoredFields(terminal, ['chatLeafId'])
    }
  }
}

export function workspaceLayoutFromPublished(published: PublishedWorkspaceLayout): WorkspaceLayout {
  const leaves: Record<string, LayoutLeaf> = {}
  const editorViews: Record<string, LayoutEditorView> = {}
  for (const tab of published.tabs) {
    if (tab.editorView) {
      editorViews[tab.id] = tab.editorView
    }
    for (const pane of tab.terminal?.panes ?? []) {
      leaves[pane.leafId] = pickStoredFields(pane, ['ptyId', 'title'])
    }
  }
  return {
    worktreeId: published.worktreeId,
    tabs: published.tabs.map(layoutTab),
    groups: published.groups.map((group) => ({ id: group.id, tabOrder: [...group.tabIds] })),
    ...(published.groupLayout ? { groupLayout: published.groupLayout } : {}),
    editorFiles: published.editorFiles.map((file) => ({ ...file })),
    ...(Object.keys(editorViews).length > 0 ? { editorViews } : {}),
    browserTabs: published.browserTabs.map((tab) => ({
      ...tab,
      // A frame without it: the tab-bar tab showing this browser tab was created with it.
      createdAt:
        tab.createdAt ??
        published.tabs.find((entry) => entry.kind === 'browser' && entry.entityId === tab.id)
          ?.createdAt ??
        0
    })),
    leaves
  }
}

/** Published tabs carry their own host; hostId is only the fallback for unstamped tabs. */
export function workspaceLayoutModelFromPublished(
  hostId: ExecutionHostId,
  layouts: Readonly<Record<string, PublishedWorkspaceLayout>>
): WorkspaceLayoutModel {
  return {
    hostId,
    workspaces: Object.fromEntries(
      Object.entries(layouts).map(([key, layout]) => [key, workspaceLayoutFromPublished(layout)])
    ),
    records: {},
    // Match window saves: every shown workspace retains a row list, even when empty.
    legacy: {
      terminalRowOwners: Object.fromEntries(Object.keys(layouts).map((key) => [key, true]))
    }
  }
}
