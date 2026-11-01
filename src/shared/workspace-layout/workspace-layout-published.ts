// Explicit layout.subscribe wire projection includes terminal startup inputs and permits live pane titles/status. Persistence-only records and view selection stay private.

import type { AgentType } from '../agent-status-types'
import type { AiVaultSessionTitle } from '../ai-vault-session-title'
import type { ExecutionHostId } from '../execution-host'
import type { TabContentType, TabGroupLayoutNode } from '../tab-types'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import { pickStoredFields } from './stored-record-fields'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import {
  tabsInOrder,
  type LayoutBrowserTab,
  type LayoutEditorFile,
  type LayoutTab,
  type LayoutTerminalCreation,
  type WorkspaceLayout
} from './workspace-layout-model'
import { tabExecutionHostId } from './workspace-layout-tab-host'
import type { LayoutEditorView } from './layout-editor-view'

export type PublishedPane = {
  leafId: string
  /** Absent while unbound. */
  ptyId?: string
  /** Rises on each pty bind, retire and rollback of the pane in this process (a same-id respawn too). */
  ptyGeneration?: number
  title?: string
  /** Unsaved live terminal title; each view chooses its tab title from its focused pane. */
  liveTitle?: string
  /** Main's start of the pane's terminal, while it has none: live state, never saved. */
  status?: PaneStartStatus
  /** Why a start failed or is held, for the pane's card. */
  statusReason?: string
  /** Unsaved outcome for the terminal main started; absent on older hosts/plain starts and removed when that terminal changes. */
  resumeOutcome?: PaneResumeOutcome
}

/** restored: resumed the agent; resume-unavailable: unverifiable agent session forced a fresh start. */
export type PaneResumeOutcome = 'restored' | 'resume-unavailable'

/** A status means no view may attach ptyId yet: it names restore input.
 * starting/resuming: main is starting; failed: start failed; sleeping: resume on first view/use; held: a newer terminal service may still run it. */
export type PaneStartStatus = 'starting' | 'failed' | 'sleeping' | 'resuming' | 'held'

export type PublishedTerminal = {
  root: TerminalPaneLayoutNode | null
  /** In tree order. */
  panes: PublishedPane[]
  chatLeafId?: string
  /** Fallback "Terminal N" title. */
  defaultTitle?: string
} & Pick<
  LayoutTerminalCreation,
  'shellOverride' | 'forceHostRuntime' | 'startupCwd' | 'launchAgent'
>

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
  /** What a non-plain editor tab shows, so a window lacking its open file can rebuild it. */
  editorView?: LayoutEditorView
}

export type PublishedEditorFile = Pick<
  LayoutEditorFile,
  | 'filePath'
  | 'relativePath'
  | 'language'
  | 'readOnly'
  | 'liveTail'
  | 'runtimeEnvironmentId'
  | 'externalSshTargetId'
>

/** `createdAt` is optional on the wire: a host from before it was published omits it. */
export type PublishedBrowserTab = Omit<LayoutBrowserTab, 'createdAt'> & { createdAt?: number }

/** Addressed by its workspace key alone; which partition owns it stays the host's routing. */
export type PublishedWorkspaceLayout = {
  worktreeId: string
  /** In canonical tab order. */
  groups: { id: string; tabIds: string[] }[]
  groupLayout?: TabGroupLayoutNode
  /** In canonical tab order. */
  tabs: PublishedTab[]
  editorFiles: PublishedEditorFile[]
  browserTabs: PublishedBrowserTab[]
}

export function publishEditorView(editorView: LayoutEditorView): LayoutEditorView {
  const { file } = editorView
  return {
    view: editorView.view,
    file: {
      filePath: file.filePath,
      relativePath: file.relativePath,
      language: file.language,
      ...pickStoredFields(file, ['runtimeEnvironmentId', 'externalSshTargetId', 'readOnly'])
    }
  }
}

export function publishEditorFile(file: LayoutEditorFile): PublishedEditorFile {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    ...pickStoredFields(file, [
      'readOnly',
      'liveTail',
      'runtimeEnvironmentId',
      'externalSshTargetId'
    ])
  }
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
    executionHostId: tabExecutionHostId(tab, workspace, partition),
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
  const editorView = workspace.editorViews?.[tab.id]
  if (editorView) {
    published.editorView = publishEditorView(editorView)
  }
  if (tab.kind === 'terminal') {
    const panes = collectLayoutLeafIdsInOrder(tab.panes.root).map((leafId): PublishedPane => {
      const leaf = workspace.leaves?.[leafId]
      return {
        leafId,
        ...(leaf ? pickStoredFields(leaf, ['ptyId', 'ptyGeneration', 'title']) : {})
      }
    })
    published.terminal = {
      root: tab.panes.root,
      panes,
      ...pickStoredFields(tab.panes, ['chatLeafId']),
      ...pickStoredFields(tab.terminal, [
        'defaultTitle',
        'shellOverride',
        'forceHostRuntime',
        'startupCwd',
        'launchAgent'
      ])
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
    editorFiles: (workspace.editorFiles ?? []).map(publishEditorFile),
    browserTabs: (workspace.browserTabs ?? []).map((tab) => ({
      id: tab.id,
      ...pickStoredFields(tab, [
        'createdAt',
        'label',
        'sessionProfileId',
        'sessionPartition',
        'pageIds'
      ])
    }))
  }
}
