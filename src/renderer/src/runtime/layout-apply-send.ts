// Store-free so store slices can send; `layout-owner-command` reads the store for other callers.
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { afterLayoutFrame } from '@/runtime/layout-frame-position'
import { holdTabPaneTree } from '@/runtime/layout-owner-pane-intents'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { PaneSide } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { LayoutEditorFile } from '../../../shared/workspace-layout/workspace-layout-model'
import type { EditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type {
  EditorFileRename,
  GroupSide,
  LayoutApplyReply,
  LayoutCommandResult,
  LayoutRefusalCode,
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
  | { type: 'closePane'; tabId: string; leafId: string; automatic?: true }
  | { type: 'renamePane'; tabId: string; leafId: string; title: string | null }
  | { type: 'equalizePanes'; tabId: string }
  | { type: 'movePane'; tabId: string; leafId: string; targetLeafId: string; side: PaneSide }
  | { type: 'setPaneRatios'; tabId: string; root: TerminalPaneLayoutNode }
  | { type: 'setChatPane'; tabId: string; leafId: string | null }
  | { type: 'moveTab'; tabId: string; toGroupId: string; index: number }
  | { type: 'splitGroup'; tabId: string; besideGroupId: string; direction: GroupSide }
  | { type: 'setGroupRatios'; groupLayout: TabGroupLayoutNode }
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
      windowDetach: { ptyId: string | null }
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
      groupId?: string
      preview?: true
      createdAt: number
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
      tabs: { tabId: string; newTabId: string; newEntityId: string }[]
      groupId: string
      file?: LayoutEditorFile
    }
  | { type: 'renameEditorFiles'; renames: EditorFileRename[] }
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

export type LayoutApplyHandlers = {
  apply: (result: LayoutCommandResult) => void
  asToday: () => void
  refused?: (code: LayoutRefusalCode) => void
  /** Main's copy lacks the target, or the call threw; `asToday` when absent. A pane split or move
   *  passes one: main keeps its pane trees over the window's saves, so that change would not last.
   *  A close keeps `asToday`: a pane main lacks has nothing to keep it. */
  unapplied?: () => void
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

/**
 * A layout command in a layout-owner build: main applies it first, then, once the window has the
 * frame with main's change, `apply` shows main's result. `asToday` runs instead when main cannot
 * act on it: a paired server holds the tab (#18202), a move's workspaces are in two partitions,
 * main's copy lacks the workspace, tab, pane or group, or the call threw. `refused` on any other
 * refusal. False when a paired server owns the workspace's layout; the caller acts as today.
 */
export function sendLayoutApply(
  state: Parameters<typeof runtimeEnvironmentIdForWorkspaceOwner>[0],
  worktreeId: string,
  command: WindowLayoutCommand,
  handlers: LayoutApplyHandlers
): boolean {
  // Why: the same owner test that mirrors a workspace's tabs from a paired server; a focused
  // server must not claim a workspace whose row names no owner. A twin stays on main's path: it
  // edits this window's layout, not either host, as the terminal-create path does.
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
  if (owner.kind === 'resolved' && owner.environmentId) {
    return false
  }
  const hold =
    PANE_COMMANDS.has(command.type) && 'tabId' in command ? holdTabPaneTree(command.tabId) : null
  // Why a task later: a handler that resolves a promise (drag-out) acts in its awaiting caller,
  // microtasks after the handler returns.
  const release = (): void => {
    if (hold) {
      setTimeout(hold, 0)
    }
  }
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
    command: { ...command, workspace: worktreeId }
  })
    .then(
      (reply) =>
        afterLayoutFrame(reply.frameSeq, () => {
          try {
            handleReply(command, reply, handlers)
          } finally {
            release()
          }
        }),
      (error: unknown) => {
        // Why: a thrown write is rolled back. An indeterminate disk write is not, and may leave a
        // pane main minted; accepted until main is the only writer.
        console.warn(`[layout-owner] ${command.type} failed:`, errorMessage(error))
        try {
          unapplied(handlers)
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
  command: WindowLayoutCommand,
  reply: LayoutApplyReply,
  handlers: LayoutApplyHandlers
): void {
  if (reply.ok) {
    handlers.apply(reply.result)
  } else if (reply.code === 'host_not_owned' || reply.code === 'other_partition') {
    handlers.asToday()
  } else if (mainLacksTarget(reply.code)) {
    // Why: main's copy lags the window's here (the window still saves its tabs).
    console.warn(`[layout-owner] ${command.type} found no target:`, reply.code)
    unapplied(handlers)
  } else {
    console.warn(`[layout-owner] ${command.type} refused:`, reply.code)
    handlers.refused?.(reply.code)
  }
}

function unapplied(handlers: LayoutApplyHandlers): void {
  if (handlers.unapplied) {
    handlers.unapplied()
  } else {
    handlers.asToday()
  }
}

const keepWindowCopy = (): void => {}

/** Records a change the window already made; any answer leaves the window's copy as it is. */
export function recordLayoutApply(
  state: Parameters<typeof sendLayoutApply>[0],
  worktreeId: string,
  command: WindowLayoutCommand
): void {
  sendLayoutApply(state, worktreeId, command, { apply: keepWindowCopy, asToday: keepWindowCopy })
}

function mainLacksTarget(code: LayoutRefusalCode): boolean {
  return (
    code === 'workspace_not_found' ||
    code === 'tab_not_found' ||
    code === 'pane_not_found' ||
    code === 'group_not_found'
  )
}

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error
}
