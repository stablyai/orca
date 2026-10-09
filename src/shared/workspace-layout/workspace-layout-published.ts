// What `layout.subscribe` publishes for one workspace: an explicit projection of the model, so the
// model's internal shape is never a wire contract. Runtime records (incarnations, sleeping agents,
// closed tabs, default-tabs marks), terminal spawn inputs and the legacy persistence record are
// not in it; neither are content facts or any view's selection.

import type { AgentType } from '../agent-status-types'
import type { AiVaultSessionTitle } from '../ai-vault-session-title'
import type { ExecutionHostId } from '../execution-host'
import type { TabContentType, TabGroupLayoutNode } from '../tab-types'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import { pickStoredFields } from './stored-record-fields'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { tabsInOrder, type LayoutTab, type WorkspaceLayout } from './workspace-layout-model'
import { tabExecutionHostId } from './workspace-layout-tab-host'

export type PublishedPane = {
  leafId: string
  /** The terminal the pane shows; absent while unbound. */
  ptyId?: string
  title?: string
}

export type PublishedTerminal = {
  root: TerminalPaneLayoutNode | null
  /** In tree order. */
  panes: PublishedPane[]
  chatLeafId?: string
  /** "Terminal N", the title shown when no other title is set. */
  defaultTitle?: string
}

export type PublishedTab = {
  id: string
  kind: TabContentType
  entityId: string
  /** The host that runs the tab's content: an editor tab's file owner, else the partition. */
  executionHostId: ExecutionHostId
  createdAt: number
  customTitle: string | null
  generatedTitle?: string | null
  aiVaultTitle?: AiVaultSessionTitle | null
  quickCommandLabel?: string | null
  color: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
  isPreview?: boolean
  agentSessionAgent?: AgentType
  terminal?: PublishedTerminal
}

export type PublishedEditorFile = {
  filePath: string
  relativePath: string
  language: string
  readOnly?: boolean
  liveTail?: boolean
}

export type PublishedBrowserTab = {
  id: string
  sessionProfileId?: string | null
  pageIds?: string[]
}

/** Addressed by its workspace key alone; which partition owns it stays the host's routing. */
export type PublishedWorkspaceLayout = {
  worktreeId: string
  /** In the one tab order. */
  groups: { id: string; tabIds: string[] }[]
  groupLayout?: TabGroupLayoutNode
  /** In the one tab order. */
  tabs: PublishedTab[]
  editorFiles: PublishedEditorFile[]
  browserTabs: PublishedBrowserTab[]
}

function publishTab(
  tab: LayoutTab,
  workspace: WorkspaceLayout,
  partition: ExecutionHostId
): PublishedTab {
  const published: PublishedTab = {
    id: tab.id,
    kind: tab.kind,
    entityId: tab.entityId,
    executionHostId: tabExecutionHostId(tab, workspace.editorFiles, partition),
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
  if (tab.kind === 'terminal') {
    const panes = collectLayoutLeafIdsInOrder(tab.panes.root).map((leafId): PublishedPane => {
      const leaf = workspace.leaves?.[leafId]
      return { leafId, ...(leaf ? pickStoredFields(leaf, ['ptyId', 'title']) : {}) }
    })
    published.terminal = {
      root: tab.panes.root,
      panes,
      ...pickStoredFields(tab.panes, ['chatLeafId']),
      ...pickStoredFields(tab.terminal, ['defaultTitle'])
    }
  }
  return published
}

export function publishWorkspaceLayout(
  workspace: WorkspaceLayout,
  partition: ExecutionHostId
): PublishedWorkspaceLayout {
  return {
    worktreeId: workspace.worktreeId,
    groups: workspace.groups.map((group) => ({ id: group.id, tabIds: [...group.tabOrder] })),
    ...(workspace.groupLayout ? { groupLayout: workspace.groupLayout } : {}),
    tabs: tabsInOrder(workspace).map((tab) => publishTab(tab, workspace, partition)),
    editorFiles: (workspace.editorFiles ?? []).map((file) => ({
      filePath: file.filePath,
      relativePath: file.relativePath,
      language: file.language,
      ...pickStoredFields(file, ['readOnly', 'liveTail'])
    })),
    browserTabs: (workspace.browserTabs ?? []).map((tab) => ({
      id: tab.id,
      ...pickStoredFields(tab, ['sessionProfileId', 'pageIds'])
    }))
  }
}
