// Route supported layout intents to paired main under its IDs only when frames draw the workspace and layout.intents.v1 is supported (H5c). Close/start/name RPCs retain server terminal-side effects. Editor opens preserve window-proposed IDs (H5d).

import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

import type {
  LayoutApplyReply,
  LayoutCommandResult
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { AppState } from '@/store/types'
import type { LayoutApplyHandlers, WindowLayoutCommand } from './layout-apply-send'
import { serverLayoutApplyRoute, type ServerLayoutApplyRoute } from './server-layout-apply-routes'
import { serverEditorFileId } from './server-layout-frame-ids'

/** Server main accepts placement, pane resize/move, props/nonterminal names, chat panes, default-tabs marks and editor opens. Never send close/start/sleep/wake intents: local-window close assumes terminals already stopped, and terminal lifecycle needs server RPC side effects. */
export const SERVER_ROUTED_LAYOUT_COMMANDS = [
  'moveTab',
  'splitGroup',
  'setGroupRatios',
  'setPaneRatios',
  'equalizePanes',
  'movePane',
  'setTabProps',
  'setChatPane',
  'renameTab',
  'movePaneToNewTab',
  'setDefaultTabsApplied',
  'openEditorTab'
] as const satisfies readonly WindowLayoutCommand['type'][]

type ServerRoutedCommand = Extract<
  WindowLayoutCommand,
  { type: (typeof SERVER_ROUTED_LAYOUT_COMMANDS)[number] }
>

const ROUTED: ReadonlySet<string> = new Set(SERVER_ROUTED_LAYOUT_COMMANDS)

function isServerRouted(command: WindowLayoutCommand): command is ServerRoutedCommand {
  // A terminal's own name goes by terminal.rename, which also names the server's terminal.
  if (command.type === 'renameTab' && command.kind === 'custom') {
    return !isWebTerminalSurfaceTabId(command.tabId)
  }
  // This desktop's guess that a launched agent exited must not clear the server's relaunch record.
  if (command.type === 'setTabProps' && command.clearLaunchAgent) {
    return false
  }
  return ROUTED.has(command.type)
}

/** An intent as it goes to a server's main, and how its answer shows here. */
export type ServerLayoutApply = {
  route: ServerLayoutApplyRoute
  command: WindowLayoutCommand
}

/** The window's drawn tabs, which place a routed move among the server's tabs. */
export type ServerMoveDrawnTabs = Partial<
  Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>
>

/** Null when the intent keeps today's path: off the list, a workspace no server frames draw, or a
 *  tab the server's frames do not hold. */
export function serverLayoutApplyFor(
  environmentId: string,
  worktreeId: string,
  command: WindowLayoutCommand,
  drawn: ServerMoveDrawnTabs = {}
): ServerLayoutApply | null {
  if (!isServerRouted(command)) {
    return null
  }
  const route = serverLayoutApplyRoute(environmentId, worktreeId)
  if (!route) {
    return null
  }
  if (command.type === 'setGroupRatios' || command.type === 'setDefaultTabsApplied') {
    // Group ids are the server's own: frames carry them unchanged; the mark names no tab.
    return { route, command }
  }
  if (command.type === 'openEditorTab') {
    // A new tab has no server id yet: editor tab ids are kept, so the proposed one is the server's.
    return { route, command: serverEditorOpen(worktreeId, command) }
  }
  const tabId = route.serverTabId(command.tabId)
  if (!tabId) {
    return null
  }
  if (command.type === 'moveTab') {
    const order = drawnGroupOrder(drawn, worktreeId, command.toGroupId)
    return {
      route,
      command: order ? serverMove(command, tabId, route, order) : anchored(command, tabId, route)
    }
  }
  // The desktop's terminal id is not the server's; that main names the moved terminal itself.
  return command.type === 'movePaneToNewTab'
    ? {
        route,
        command: { ...command, tabId, windowDetach: { ...command.windowDetach, ptyId: null } }
      }
    : { route, command: { ...command, tabId } }
}

type EditorOpen = Extract<WindowLayoutCommand, { type: 'openEditorTab' }>

/** An editor open under the server's ids: its own file id, and a record owned by no environment. */
export function serverEditorOpen(worktreeId: string, command: EditorOpen): EditorOpen {
  const { file, ...rest } = command
  const fileId = serverEditorFileId(command.fileId, worktreeId, file ? [file] : [])
  if (!file) {
    return { ...rest, fileId }
  }
  const { runtimeEnvironmentId: _desktopOwner, ...serverFile } = file
  return { ...rest, fileId, file: serverFile }
}

type MoveTab = Extract<WindowLayoutCommand, { type: 'moveTab' }>

/** A group's tabs that have a row: a hidden launch slot is not one. */
function drawnGroupOrder(
  drawn: ServerMoveDrawnTabs,
  worktreeId: string,
  groupId: string
): string[] | undefined {
  const order = drawn.groupsByWorktree?.[worktreeId]?.find(
    (group) => group.id === groupId
  )?.tabOrder
  const rows = drawn.unifiedTabsByWorktree?.[worktreeId]
  if (!order || !rows) {
    return undefined
  }
  const ids = new Set(rows.map((tab) => tab.id))
  return order.filter((id) => ids.has(id))
}

/**
 * A move placed among the server's tabs: this desktop's own tabs and any the server does not hold
 * are skipped, so the anchor is the nearest server tab before the slot and the index counts only
 * server tabs.
 */
function serverMove(
  command: MoveTab,
  tabId: string,
  route: ServerLayoutApplyRoute,
  desktopOrder: readonly string[]
): MoveTab {
  const others = desktopOrder.filter((id) => id !== command.tabId)
  const after = command.afterTabId ? others.indexOf(command.afterTabId) : -1
  const slot =
    command.afterTabId === null
      ? 0
      : after !== -1
        ? after + 1
        : Math.min(Math.max(command.index, 0), others.length)
  const serverBefore = others.slice(0, slot).flatMap((id) => route.serverTabId(id) ?? [])
  return { ...command, tabId, index: serverBefore.length, afterTabId: serverBefore.at(-1) ?? null }
}

/** With no drawn order: an anchor the server does not hold is dropped, never sent raw, so its main
 *  uses `index`. */
function anchored(command: MoveTab, tabId: string, route: ServerLayoutApplyRoute): MoveTab {
  if (!command.afterTabId) {
    return { ...command, tabId }
  }
  const { afterTabId, ...rest } = command
  const serverAnchor = route.serverTabId(afterTabId)
  return serverAnchor ? { ...rest, tabId, afterTabId: serverAnchor } : { ...rest, tabId }
}

/**
 * Shows a server's answer. A refusal, or a call that never reached it, redraws the workspace from
 * the server's frames: nothing applies here instead, since only that main changes its layout.
 */
export function handleServerLayoutReply(
  server: ServerLayoutApply,
  type: WindowLayoutCommand['type'],
  reply: LayoutApplyReply | null,
  handlers: LayoutApplyHandlers
): void {
  if (reply?.ok) {
    handlers.apply(resultForDesktop(reply.result, server.route), {
      framesKey: server.route.environmentId,
      routed: true
    })
    return
  }
  const code = reply ? reply.code : 'call_failed'
  console.warn(`[layout-owner] ${type} refused by the server:`, code)
  server.route.redraw()
  handlers.refused?.(code)
}

function resultForDesktop(
  result: LayoutCommandResult,
  route: ServerLayoutApplyRoute
): LayoutCommandResult {
  return result.tabId === undefined
    ? result
    : { ...result, tabId: route.desktopTabId(result.tabId) }
}
