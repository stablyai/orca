// Store-free so store slices can send; `layout-owner-command` reads the store for other callers.
import {
  runtimeEnvironmentIdForWorkspaceOwner,
  runtimeEnvironmentIdUnlessTwin
} from '@/lib/resolve-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { afterLayoutFrame } from '@/runtime/layout-frame-position'
import { holdTabPaneTree } from '@/runtime/layout-owner-pane-intents'
import { holdDrawnTabs, type DrawnTabHold } from '@/runtime/layout-owner-drawn-tab-holds'
import { releaseLayoutApplyHolds } from '@/runtime/layout-apply-hold-release'
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
  | { type: 'moveTab'; tabId: string; toGroupId: string; index: number }
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
      createdAt: number
      browserCreatedAt: number
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
      createdAt: number
      split?: NewGroupSplit
    }
  | { type: 'promotePreviewTab'; tabId: string }
  | {
      type: 'openSimulatorTab'
      tabId: string
      groupId: string
      afterTabId?: string
      index?: number
      createdAt: number
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
  | { type: 'wake'; tabId: string; paneKeys: [string] }
  /** Drops the panes' resume records without starting them. */
  | { type: 'wake'; tabId: string; paneKeys: string[]; recordOnly: true }
  | { type: 'setDefaultTabsApplied' }
  | (Omit<CommandOf<'createTerminalTab'>, 'workspace'> & { tabId: string; leafId: string })

/** `call_failed`: the call threw, and a thrown write is rolled back. */
export type WindowRefusalCode = Extract<LayoutApplyReply, { ok: false }>['code'] | 'call_failed'

export type LayoutApplyHandlers = {
  apply: (result: LayoutCommandResult) => void
  asToday: () => void
  refused?: (code: WindowRefusalCode) => void
  /** The window already drew the change: frames keep its tabs as drawn until the answer is in. */
  drawn?: true
}

/** Commands that change one tab's panes: frames wait to redraw that tab until the answer is in. */
const PANE_COMMANDS: ReadonlySet<WindowLayoutCommand['type']> = new Set([
  'splitPane',
  'closePane',
  'renamePane',
  'equalizePanes',
  'movePane',
  'setPaneRatios',
  'setChatPane',
  'movePaneToNewTab'
])

/** The tabs, by workspace, that a command the window already drew changes. */
function drawnTabHolds(worktreeId: string, command: WindowLayoutCommand): DrawnTabHold[] {
  switch (command.type) {
    case 'closeTabs':
      return [{ workspace: worktreeId, ids: command.tabIds }]
    case 'openBrowserTab':
      return [{ workspace: worktreeId, ids: [command.tabId, command.browserTabId] }]
    case 'splitGroup':
      return [{ workspace: worktreeId, ids: [command.tabId], groupLayout: true }]
    case 'moveTab':
    case 'renameTab':
    case 'setTabProps':
    case 'openAgentSessionTab':
    case 'openSimulatorTab':
    case 'createTerminalTab':
      return [{ workspace: worktreeId, ids: [command.tabId] }]
    case 'openBrowserPage':
    case 'closeBrowserPage':
    case 'replaceBrowserPage':
    case 'setBrowserTabProfile':
      return [{ workspace: worktreeId, ids: [command.browserTabId] }]
    case 'setGroupRatios':
      return [{ workspace: worktreeId, ids: [], groupLayout: true }]
    // Pane commands hold their tab's pane tree; records are not drawn from frames; editor opens,
    // promotions, moves and renames are sent before the window draws them.
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
    case 'setDefaultTabsApplied':
      return []
  }
}

/**
 * A layout command in a layout-owner build: main applies it first, then, once the window has the
 * frame with main's change, `apply` shows main's result. `asToday` runs instead only when a paired
 * server may hold the tab (#18202). Any other refusal (main's copy lacking the target too), and a
 * call that threw, is logged and `refused`: main's frame stays what is drawn, since a window save
 * no longer carries the change. False when a paired server owns the workspace's layout; the
 * caller acts as today.
 */
export function sendLayoutApply(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  worktreeId: string,
  command: WindowLayoutCommand,
  handlers: LayoutApplyHandlers
): boolean {
  // Why: the same owner test that mirrors a workspace's tabs from a paired server; a focused
  // server must not claim a workspace whose row names no owner. A twin stays on main's path: it
  // edits this window's layout, not either host, as the terminal-create path does.
  if (runtimeEnvironmentIdUnlessTwin(state, worktreeId)) {
    return false
  }
  const hold =
    PANE_COMMANDS.has(command.type) && 'tabId' in command ? holdTabPaneTree(command.tabId) : null
  const tabHolds = handlers.drawn ? drawnTabHolds(worktreeId, command) : []
  const tabHold = tabHolds.length > 0 ? holdDrawnTabs(tabHolds) : null
  const release = releaseLayoutApplyHolds(command.type, [hold, tabHold])
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
    command: { ...command, workspace: worktreeId }
  })
    .then(
      (reply) =>
        afterLayoutFrame(reply.frameSeq, () => {
          try {
            handleReply(state, worktreeId, command, reply, handlers)
          } finally {
            release()
          }
        }),
      (error: unknown) => {
        // Why: a thrown write is rolled back. An indeterminate disk write is not, and may leave a
        // pane main minted, which its frame then draws.
        console.warn(`[layout-owner] ${command.type} refused: call_failed`, errorMessage(error))
        try {
          handlers.refused?.('call_failed')
        } finally {
          release()
        }
      }
    )
    // A throwing handler is not a failed call; it must not run the fallback too.
    .catch((error: unknown) => {
      console.warn(`[layout-owner] ${command.type} handler threw:`, errorMessage(error))
    })
  return true
}

function handleReply(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  worktreeId: string,
  command: WindowLayoutCommand,
  reply: LayoutApplyReply,
  handlers: LayoutApplyHandlers
): void {
  if (reply.ok) {
    handlers.apply(reply.result)
  } else if (refusalActsAsToday(state, worktreeId, reply.code)) {
    handlers.asToday()
  } else {
    console.warn(`[layout-owner] ${command.type} refused:`, reply.code)
    handlers.refused?.(reply.code)
  }
}

/** A refusal the window answers as today: a twin's, which main may route to a paired server. */
export function refusalActsAsToday(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  worktreeId: string,
  code: WindowRefusalCode
): boolean {
  return code === 'host_not_owned' && mayBePairedServers(state, worktreeId)
}

/** A twin: main may route it to a paired server, whose layout the window still mirrors. */
function mayBePairedServers(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  worktreeId: string
): boolean {
  return (
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

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error
}
