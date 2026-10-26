// Store-free so store slices can send; `layout-owner-command` reads the store for other callers.
import {
  runtimeEnvironmentIdForWorkspaceOwner,
  runtimeEnvironmentIdUnlessTwin
} from '@/lib/resolve-owner'
import { callLayoutApply } from '@/runtime/layout-apply-call'
import { holdTabPaneTree } from '@/runtime/layout-owner-pane-intents'
import { holdDrawnTabs, type DrawnTabHold } from '@/runtime/layout-owner-drawn-tab-holds'
import { holdsPaneTree, releaseLayoutApplyHolds } from '@/runtime/layout-apply-hold-release'
import { handleServerLayoutReply, serverLayoutApplyFor } from '@/runtime/server-layout-apply'
import type { ServerMoveDrawnTabs } from '@/runtime/server-layout-apply'
import {
  LOCAL_LAYOUT_APPLY_ORIGIN,
  type LayoutApplyOrigin
} from '@/runtime/server-layout-apply-routes'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { SplitRatioIntent } from '../../../shared/workspace-layout/split-ratio-intents'
import type { PaneSide } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { LayoutEditorFile } from '../../../shared/workspace-layout/workspace-layout-model'
import type { LayoutEditorView } from '../../../shared/workspace-layout/layout-editor-view'
import type { EditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type {
  CommandOf,
  EditorFileRename,
  GroupSide,
  LayoutApplyReply,
  LayoutCommandResult,
  NewGroupSplit,
  TabTitle
} from '../../../shared/workspace-layout/workspace-layout-command-types'

/** What a window sends `layout.apply`; main mints any new id but one the window already drew. */
export type WindowLayoutCommand =
  | {
      type: 'splitPane'
      tabId: string
      leafId: string
      direction: 'vertical' | 'horizontal'
      /** A pane the window already split under its own id. */
      newLeafId?: string
    }
  | { type: 'closePane'; tabId: string; leafId: string }
  | { type: 'renamePane'; tabId: string; leafId: string; title: string | null }
  | { type: 'equalizePanes'; tabId: string }
  | { type: 'movePane'; tabId: string; leafId: string; targetLeafId: string; side: PaneSide }
  | { type: 'setPaneRatios'; tabId: string; ratios: SplitRatioIntent[] }
  | { type: 'setChatPane'; tabId: string; leafId: string | null }
  | {
      type: 'moveTab'
      tabId: string
      toGroupId: string
      index: number
      afterTabId?: string | null
      isPinned?: boolean
    }
  | { type: 'splitGroup'; tabId: string; besideGroupId: string; direction: GroupSide }
  | { type: 'setGroupRatios'; ratios: SplitRatioIntent[] }
  | { type: 'closeTabs'; tabIds: [string]; recordClose?: 'user' | 'cleanup' }
  | ({ type: 'renameTab'; tabId: string } & TabTitle)
  | {
      type: 'setTabProps'
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      clearLaunchAgent?: true
    }
  | {
      type: 'movePaneToNewTab'
      tabId: string
      leafId: string
      groupId: string
      index?: number
      windowDetach: { ptyId: string | null; startupCwd?: string }
    }
  | {
      type: 'openBrowserTab'
      tabId: string
      browserTabId: string
      pageId: string
      profileId: string | null
      sessionPartition: string | null
      groupId?: string
      afterTabId?: string
      index?: number
      /** Absent from a switch-on open: main stamps the tab's time. */
      createdAt?: number
      browserCreatedAt?: number
      split?: NewGroupSplit
    }
  | { type: 'openBrowserPage' | 'closeBrowserPage'; browserTabId: string; pageId: string }
  | { type: 'replaceBrowserPage'; browserTabId: string; pageId: string; newPageId: string }
  | {
      type: 'setBrowserTabProfile'
      browserTabId: string
      profileId: string | null
      sessionPartition: string | null
    }
  | {
      type: 'openEditorTab'
      tabId: string
      fileId: string
      contentType: EditorTabContentType
      file?: LayoutEditorFile
      view?: LayoutEditorView
      groupId?: string
      index?: number
      preview?: true
      /** Absent from a switch-on open: main stamps the tab's time (ledger L186). */
      createdAt?: number
      split?: NewGroupSplit
    }
  | {
      type: 'openAgentSessionTab'
      tabId: string
      sessionId: string
      agent: string
      groupId: string
      afterTabId?: string
      index?: number
      createdAt?: number
      split?: NewGroupSplit
    }
  | { type: 'promotePreviewTab'; tabId: string }
  | {
      type: 'openSimulatorTab'
      tabId: string
      kind?: CommandOf<'openSimulatorTab'>['kind']
      groupId: string
      afterTabId?: string
      index?: number
      createdAt?: number
      split?: NewGroupSplit
    }
  | {
      type: 'moveTabToWorkspace'
      toWorkspace: string
      tabs: { tabId: string; newTabId: string; newEntityId: string; view?: LayoutEditorView }[]
      groupId: string
      file?: LayoutEditorFile
    }
  | {
      type: 'renameEditorFiles'
      renames: EditorFileRename[]
      alsoIn?: { workspace: string; renames: EditorFileRename[] }[]
    }
  | {
      type: 'sleep'
      tabId: string
      paneKeys: string[]
      records: SleepingAgentSessionRecord[]
      /** Records how the panes' agents resume without stopping them (a live or quit capture). */
      recordOnly?: true
    }
  /** Main starts the pane if its terminal is not live; the window then attaches. */
  | { type: 'startPane'; tabId: string; paneKey: string }
  | { type: 'wake'; tabId: string; paneKeys: [string] }
  /** Drops the panes' resume records without starting them. */
  | { type: 'wake'; tabId: string; paneKeys: string[]; recordOnly: true }
  | { type: 'setDefaultTabsApplied' }
  | (Omit<CommandOf<'createTerminalTab'>, 'workspace'> & { tabId: string; leafId: string })

/** `call_failed`: the call threw, and a thrown write is rolled back. */
export type WindowRefusalCode = Extract<LayoutApplyReply, { ok: false }>['code'] | 'call_failed'

export type LayoutApplyHandlers = {
  apply: (result: LayoutCommandResult, origin: LayoutApplyOrigin) => void
  asToday: () => void
  refused?: (code: WindowRefusalCode) => void
  /** The window already drew the change: frames keep its tabs as drawn until the answer is in. */
  drawn?: true
}

/** The tabs, by workspace, that a command the window already drew changes. */
function drawnTabHolds(worktreeId: string, command: WindowLayoutCommand): DrawnTabHold[] {
  switch (command.type) {
    case 'closeTabs':
      return [{ workspace: worktreeId, ids: command.tabIds }]
    case 'splitGroup':
      return [{ workspace: worktreeId, ids: [command.tabId], groupLayout: true }]
    case 'moveTab':
    case 'renameTab':
    case 'setTabProps':
    case 'createTerminalTab':
      return [{ workspace: worktreeId, ids: [command.tabId] }]
    case 'setGroupRatios':
      return [{ workspace: worktreeId, ids: [], groupLayout: true }]
    // Pane commands hold their drawn tree; records are not frame-drawn. Editor/browser/chat/simulator opens and page changes send before drawing.
    case 'openBrowserTab':
    case 'openBrowserPage':
    case 'closeBrowserPage':
    case 'replaceBrowserPage':
    case 'setBrowserTabProfile':
    case 'openAgentSessionTab':
    case 'openSimulatorTab':
    case 'openEditorTab':
    case 'promotePreviewTab':
    case 'moveTabToWorkspace':
    case 'renameEditorFiles':
    case 'splitPane':
    case 'closePane':
    case 'renamePane':
    case 'equalizePanes':
    case 'movePane':
    case 'setPaneRatios':
    case 'setChatPane':
    case 'movePaneToNewTab':
    case 'sleep':
    case 'wake':
    case 'startPane':
    case 'setDefaultTabsApplied':
      return []
  }
}

/** Main applies first; apply shows its result after the matching frame. Only possible paired-server ownership permits asToday (#18202); other refusals/thrown calls log and retain main’s drawing because window saves no longer persist changes. Frame-drawn paired workspaces route SERVER_ROUTED_LAYOUT_COMMANDS to their own main; other cases return false for existing caller behavior. */
export function sendLayoutApply(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0] & ServerMoveDrawnTabs,
  worktreeId: string,
  command: WindowLayoutCommand,
  handlers: LayoutApplyHandlers
): boolean {
  // Use mirror ownership, never server focus: hostless rows are local. Twins retain local-main handling rather than choosing either host, matching terminal creation.
  const environmentId = runtimeEnvironmentIdUnlessTwin(state, worktreeId)
  // A paired server's workspace: its main takes the intent when its frames draw the workspace.
  const server = environmentId
    ? serverLayoutApplyFor(environmentId, worktreeId, command, state)
    : null
  if (environmentId && !server) {
    return false
  }
  const hold =
    holdsPaneTree(command.type) && 'tabId' in command ? holdTabPaneTree(command.tabId) : null
  const tabHolds = handlers.drawn ? drawnTabHolds(worktreeId, command) : []
  const tabHold = tabHolds.length > 0 ? holdDrawnTabs(tabHolds) : null
  const release = releaseLayoutApplyHolds(command.type, [hold, tabHold])
  const target: RuntimeClientTarget = server
    ? { kind: 'environment', environmentId: server.route.environmentId }
    : { kind: 'local' }
  callLayoutApply(target, worktreeId, server?.command ?? command, (reply) => {
    try {
      if (server) {
        handleServerLayoutReply(server, command.type, reply, handlers)
      } else if (reply) {
        handleReply(state, worktreeId, command, reply, handlers)
      } else {
        handlers.refused?.('call_failed')
      }
    } finally {
      release()
    }
  })
  return true
}

/**
 * Sends one intent to a paired server's main, never this window's: a workspace's editor tabs
 * handed over before that server's frames draw it (H5d).
 */
export function sendToServerMain(
  environmentId: string,
  worktreeId: string,
  command: WindowLayoutCommand,
  answer: (reply: LayoutApplyReply | null) => void
): void {
  callLayoutApply({ kind: 'environment', environmentId }, worktreeId, command, answer)
}

function handleReply(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  worktreeId: string,
  command: WindowLayoutCommand,
  reply: LayoutApplyReply,
  handlers: LayoutApplyHandlers
): void {
  if (reply.ok) {
    handlers.apply(reply.result, LOCAL_LAYOUT_APPLY_ORIGIN)
  } else if (refusalActsAsToday(state, worktreeId, reply.code)) {
    handlers.asToday()
  } else {
    console.warn(`[layout-owner] ${command.type} refused:`, reply.code)
    handlers.refused?.(reply.code)
  }
}

/** A refusal the window answers as today: a twin's, which main may route to a paired server, whose
 *  layout the window still mirrors. */
export function refusalActsAsToday(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  worktreeId: string,
  code: WindowRefusalCode
): boolean {
  return (
    code === 'host_not_owned' &&
    runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId }).kind !== 'resolved'
  )
}

const keepWindowCopy = (): void => {}

/** Records a change the window already made: drawn as the window made it until main answers. */
export function recordLayoutApply(
  state: Parameters<typeof sendLayoutApply>[0],
  worktreeId: string,
  command: WindowLayoutCommand
): void {
  sendLayoutApply(state, worktreeId, command, {
    apply: keepWindowCopy,
    asToday: keepWindowCopy,
    drawn: true
  })
}
