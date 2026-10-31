import { workspaceProtocolPlacement } from './workspace-command-address'
import { isPresentationOnlyCommand } from '../../../shared/workspace-presentation-intent'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { workspacePresentationFor, workspaceSourceTab } from '@/store/workspace-composition'
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
import type {
  LayoutApplyReply,
  LayoutCommandResult
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from './window-layout-command'
export type { WindowLayoutCommand } from './window-layout-command'

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
  const presentation = workspacePresentationFor(state, worktreeId)
  if (presentation && isPresentationOnlyCommand(command)) {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      return false
    }
    callLayoutApply({ kind: 'local' }, presentation.displayWorkspaceId, command, (reply) => {
      if (reply?.ok) {
        handlers.apply(reply.result, LOCAL_LAYOUT_APPLY_ORIGIN)
      } else {
        handlers.refused?.(reply ? reply.code : 'call_failed')
      }
    })
    return true
  }
  const sourceTabId =
    'tabId' in command
      ? command.tabId
      : command.type === 'closeTabs'
        ? command.tabIds[0]
        : undefined
  const sourceTab = sourceTabId ? workspaceSourceTab(state, sourceTabId, worktreeId) : undefined
  if (sourceTab) {
    worktreeId = sourceTab.worktreeId
    if (
      !presentation &&
      (command.type === 'movePaneToNewTab' || command.type === 'createTerminalTab')
    ) {
      command = { ...command, groupId: sourceTab.groupId }
    }
  }
  // Use mirror ownership, never server focus: hostless rows are local. Twins retain local-main handling rather than choosing either host, matching terminal creation.
  const environmentId = runtimeEnvironmentIdUnlessTwin(state, worktreeId)
  if (
    presentation &&
    environmentId &&
    'groupId' in command &&
    command.type !== 'moveTabToWorkspace'
  ) {
    const placement = workspaceProtocolPlacement(
      state,
      environmentId,
      worktreeId,
      command.groupId,
      'afterTabId' in command ? command.afterTabId : undefined
    )
    command = {
      ...command,
      groupId: placement.targetGroupId,
      ...('afterTabId' in command ? { afterTabId: placement.afterTabId } : {})
    }
  }
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
