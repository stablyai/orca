// C3: window draws immediately for synchronous callers; main records the same IDs before later pane commands. Main-created tabs retain main’s facts so window saves do not mutate them.

import { createBrowserUuid } from '@/lib/browser-uuid'
import { afterLayoutFrame } from '@/runtime/layout-frame-position'
import { expectTabRowFields } from '@/runtime/layout-owner-pane-intents'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import { newGroupSplitOf } from '@/runtime/layout-owner-new-group-split'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { layoutFrameTerminalTab } from '@/runtime/layout-frame-terminal-panes'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { pickStoredFields } from '../../../../shared/workspace-layout/stored-record-fields'
import type {
  CommandOf,
  LayoutApplyReply
} from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { AppState } from '../types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  clearWindowTabMark,
  markWindowTabStarting,
  startWindowTabInMain,
  windowTabStartsInMain
} from './window-tab-start-in-main'

/** Use main’s creation facts while retaining fields it omitted, such as window-resolved WSL shell when launch named none. */
export function withMainTerminalFacts(tab: TerminalTab): TerminalTab {
  const main = layoutFrameTerminalTab(tab.worktreeId, tab.id)
  if (!main) {
    return tab
  }
  const terminal = main.terminal
  return {
    ...tab,
    createdAt: main.createdAt,
    ...(terminal?.defaultTitle
      ? { title: terminal.defaultTitle, defaultTitle: terminal.defaultTitle }
      : {}),
    ...(terminal
      ? pickStoredFields(terminal, [
          'shellOverride',
          'startupCwd',
          'forceHostRuntime',
          'launchAgent'
        ])
      : {})
  }
}

/** What the window's `createTab` just drew, as main's create command. */
export function terminalTabCreateCommand(
  state: AppState,
  tab: TerminalTab
): CommandOf<'createTerminalTab'> & { tabId: string; leafId: string } {
  const root = state.terminalLayoutsByTabId[tab.id]?.root
  const entry = state.unifiedTabsByWorktree[tab.worktreeId]?.find(
    (candidate) => candidate.entityId === tab.id && candidate.contentType === 'terminal'
  )
  const creation = {
    defaultTitle: tab.defaultTitle ?? tab.title,
    ...(tab.shellOverride ? { shellOverride: tab.shellOverride } : {}),
    ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
    ...(tab.forceHostRuntime ? { forceHostRuntime: true } : {}),
    ...(tab.launchAgent ? { launchAgent: tab.launchAgent } : {})
  }
  return {
    type: 'createTerminalTab',
    workspace: tab.worktreeId,
    tabId: tab.id,
    // createTab always lays out a single first pane.
    leafId: root?.type === 'leaf' ? root.leafId : '',
    // Main makes a split made with the tab along with it, and takes the group as a workspace's
    // first when it holds none.
    ...(entry
      ? {
          groupId: entry.groupId,
          ...newGroupSplitOf(state, tab.worktreeId, entry.groupId, entry.id)
        }
      : {}),
    ...(entry?.viewMode ? { viewMode: entry.viewMode } : {}),
    ...(tab.quickCommandLabel?.trim() ? { quickCommandLabel: tab.quickCommandLabel.trim() } : {}),
    createdAt: entry?.createdAt ?? tab.createdAt,
    creation
  }
}

/** Keep drawn tab pending until main answers; refusal closes/stops it. Server-routed twins retain their window/partition copy. */
export function recordCreatedTerminalTabInLayoutOwner(
  state: AppState,
  command: CommandOf<'createTerminalTab'> & { tabId: string; leafId: string },
  start?: { tab: TerminalTab; store: Parameters<typeof startWindowTabInMain>[0] }
): void {
  // Why: a tab main already holds is its own.
  if (layoutFrameTerminalTab(command.workspace, command.tabId)) {
    return
  }
  const { workspace, ...rest } = command
  // Main starts the first terminal once it holds the tab; until then the pane waits for it.
  const startsInMain =
    start !== undefined &&
    runtimeEnvironmentIdUnlessTwin(state, workspace) === null &&
    windowTabStartsInMain(state, start.tab)
  const mark = startsInMain
    ? markWindowTabStarting(start.store, command.tabId, command.leafId)
    : null
  const unmark = (): void => {
    if (start && mark) {
      clearWindowTabMark(start.store, makePaneKey(command.tabId, command.leafId), mark)
    }
  }
  const sent = sendLayoutApply(state, workspace, rest, {
    apply: () => {
      if (start && mark) {
        startWindowTabInMain(start.store, start.tab, command.leafId, mark)
      }
    },
    // A paired server may hold it: the pane starts its own terminal, as today.
    asToday: unmark,
    refused: () => {
      unmark()
      state.closeTab(command.tabId, { reason: 'cleanup' })
    },
    drawn: true
  })
  if (!sent) {
    unmark()
  }
}

/** F23: main atomically creates only in empty owned workspaces, preventing concurrent window/runtime duplicates. Frames/reopened snapshots carry window row fields; paired ownership or rolled-back writes use create fallback. */
export function createInitialTerminalThroughLayoutOwner(
  getState: () => AppState,
  worktreeId: string,
  create: () => void
): boolean {
  if (runtimeEnvironmentIdUnlessTwin(getState(), worktreeId) !== null) {
    return false
  }
  const tabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  // Today's create, only while the workspace is still shown and still empty, as before the await.
  const createAsToday = (): void => {
    const state = getState()
    if (state.activeWorktreeId === worktreeId && !state.tabsByWorktree[worktreeId]?.length) {
      create()
    }
  }
  // Kept until the frame bringing main's tab takes it, even one an owed write holds back.
  const release = expectTabRowFields(tabId, ACTIVATION_ROW_FIELDS)
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
    command: {
      type: 'createTerminalTab',
      workspace: worktreeId,
      tabId,
      leafId,
      initial: 'activation'
    }
  })
    .then(
      (reply) =>
        // After the frame with main's tab: the stream may end first, and the window draws it then.
        afterLayoutFrame(reply.frameSeq, () => {
          if (reply.ok && reply.result.tabId === tabId) {
            return
          }
          // No tab id: main's copy already shows a tab here, which its frames bring.
          release()
          if (!reply.ok && reply.code === 'host_not_owned') {
            createAsToday()
          } else if (!reply.ok) {
            console.warn('[layout-owner] initial createTerminalTab refused:', reply.code)
          }
        }),
      (error: unknown) => {
        release()
        // Why as today: a thrown write is rolled back, so main holds no such tab.
        console.warn(
          '[layout-owner] initial createTerminalTab failed:',
          error instanceof Error ? error.message : error
        )
        createAsToday()
      }
    )
    .catch((error: unknown) => {
      console.warn(
        '[layout-owner] initial terminal create threw:',
        error instanceof Error ? error.message : error
      )
    })
  return true
}

/** The window's own mark on a first terminal: its spawn does not count as workspace activity. */
const ACTIVATION_ROW_FIELDS = { pendingActivationSpawn: true } as const
