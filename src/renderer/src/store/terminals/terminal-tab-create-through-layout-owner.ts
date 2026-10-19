// Terminal tab creates in a layout-owner build (phase C3). Main writes each tab under the ids the
// window drew it with, before any later command from this window names its pane, so a split of a
// just-created pane finds it. The window still draws first: its callers act on the tab at once
// (select, retitle, anchor, mount, launch). Main's copy reaches the window through layout frames.
// A tab main made itself (CLI, drag-out, a host's terminal) is drawn with main's own facts, so the
// window's save of it changes nothing in main.

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

/**
 * The row a tab main made itself is drawn with: main's time, title and the creation fields main
 * recorded. A field main's copy lacks keeps the window's: a runtime create records a shell only
 * when its launch named one, so a WSL worktree's resolved shell lives only here.
 */
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

/**
 * Sends a tab the window just drew to main; frames keep it as drawn until main answers. A refusal
 * is logged and the window closes the tab, stopping its terminal, since main's frame will not
 * have it. A twin that main may route to a paired server keeps it: the window's save carries the
 * server's partition as it is.
 */
export function recordCreatedTerminalTabInLayoutOwner(
  state: AppState,
  command: CommandOf<'createTerminalTab'> & { tabId: string; leafId: string }
): void {
  // Why: a tab main already holds is its own.
  if (layoutFrameTerminalTab(command.workspace, command.tabId)) {
    return
  }
  const { workspace, ...rest } = command
  const keep = (): void => {}
  sendLayoutApply(state, workspace, rest, {
    apply: keep,
    asToday: keep,
    refused: () => state.closeTab(command.tabId, { reason: 'cleanup' }),
    drawn: true
  })
}

/**
 * A workspace's first terminal on activation (F23). Main creates it only into a workspace its copy
 * holds no tab of, so this window and the runtime asking at once still make one tab. Main's frame
 * draws it, with the window's own row fields; while the stream is down, the reopened stream's
 * snapshot does. False when a paired server owns the workspace's layout. `create` opens the
 * terminal as today: main does not own the workspace (a twin it routes to a paired
 * server, whose partition the window's save carries), or the call threw and was rolled back.
 */
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
          // Main's frame draws it, a reopened stream's snapshot too.
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

/**
 * A live terminal the host's census finds no pane for, shown through main: main answers with the
 * pane it already holds for it (a CLI tab this window never mounted), else makes a tab bound to it,
 * and its frame draws either. 'as-today': the window shows it itself, since a paired server owns
 * the workspace, main does not own it (a twin), or the call threw (a thrown write is rolled back).
 * 'refused': main showed nothing, so the terminal stays without a pane.
 */
export async function adoptLiveTerminalThroughLayoutOwner(
  getState: () => Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  worktreeId: string,
  terminal: { ptyId: string; recordedPaneKey?: string }
): Promise<'shown' | 'refused' | 'as-today'> {
  if (runtimeEnvironmentIdUnlessTwin(getState(), worktreeId) !== null) {
    return 'as-today'
  }
  try {
    const reply = await callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
      command: {
        type: 'createTerminalTab',
        workspace: worktreeId,
        tabId: createBrowserUuid(),
        leafId: createBrowserUuid(),
        adopt: terminal
      }
    })
    if (reply.ok) {
      return 'shown'
    }
    if (reply.code === 'host_not_owned') {
      return 'as-today'
    }
    console.warn('[layout-owner] live terminal adoption refused:', reply.code)
    return 'refused'
  } catch (error) {
    console.warn(
      '[layout-owner] live terminal adoption failed:',
      error instanceof Error ? error.message : error
    )
    return 'as-today'
  }
}

/** The window's own mark on a first terminal: its spawn does not count as workspace activity. */
const ACTIVATION_ROW_FIELDS = { pendingActivationSpawn: true } as const
