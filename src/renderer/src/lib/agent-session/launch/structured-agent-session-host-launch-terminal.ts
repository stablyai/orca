/** A host launch that started its terminal instead of the chat: the chat's tab gives way to that
 *  terminal once this window draws it, in the place a declined chat's terminal takes. */

import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import { useAppStore } from '@/store/index'
import type { OpenedAgentSessionTab } from '../../structured-agent-session-tab-open-through-layout-owner'
import {
  declinedChat,
  replaceDeclinedChat,
  type DeclinedChat,
  type DeclinedChatCaller
} from './structured-agent-session-action-launch'
import { StructuredHostLaunchTerminalError } from './structured-agent-session-host-launch'
import {
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { findStructuredLaunchTab } from './structured-agent-session-launch-surface'
import {
  workspaceTabIdShown,
  workspaceTerminalForHostTab
} from './structured-agent-session-launch-tab-index'

// The host's reveal reaches this window a moment after its answer, and main's move of it a moment
// after that; past this the chat stays and says the terminal opened where it could not be shown.
const HOST_TERMINAL_DRAWN_WITHIN_MS = 10_000

/** Resolves with `found()` once it is defined, checked as this workspace's tabs or groups or any
 *  launch's status change; undefined once the chat is closed, its launch replaced or cancelled, or
 *  `deadline` passes. Every exit ends its watches and timer. */
function awaitWhileChatHeld<T>(
  args: DeclinedChatCaller,
  worktreeId: string,
  tab: OpenedAgentSessionTab,
  { launchState, attempt }: DeclinedChat,
  deadline: number,
  found: () => T | undefined
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let done = false
    const stops: (() => void)[] = []
    const finish = (value: T | undefined): void => {
      if (!done) {
        done = true
        clearTimeout(timer)
        stops.forEach((stop) => stop())
        resolve(value)
      }
    }
    const check = (): void => {
      const held =
        getStructuredLaunchStateBySessionId(tab.entityId) === launchState &&
        launchState?.callers === attempt &&
        !launchState?.cancelled &&
        !args.hooks.signal?.aborted &&
        workspaceTabIdShown(useAppStore.getState().unifiedTabsByWorktree[worktreeId], tab.id)
      const value = held ? found() : undefined
      if (!held || value !== undefined) {
        finish(value)
      }
    }
    const timer = setTimeout(() => finish(undefined), Math.max(0, deadline - Date.now()))
    // Only this workspace's lists can show it: other writes leave their identity alone.
    stops.push(
      useAppStore.subscribe((state, previous) => {
        if (
          state.unifiedTabsByWorktree[worktreeId] !== previous.unifiedTabsByWorktree[worktreeId] ||
          state.groupsByWorktree[worktreeId] !== previous.groupsByWorktree[worktreeId]
        ) {
          check()
        }
      }),
      subscribeStructuredAgentLaunchStatus(check)
    )
    // Registered first, so a change made before this check is not missed.
    check()
  })
}

/** Driven by the host's own result, never by a refusal: the terminal already exists. */
export async function adoptHostLaunchedTerminal(
  args: DeclinedChatCaller,
  worktreeId: string,
  tab: OpenedAgentSessionTab,
  settlement: StructuredAgentLaunchSettlement
): Promise<StructuredAgentLaunchSettlement> {
  if (
    settlement.kind !== 'failed' ||
    !(settlement.error instanceof StructuredHostLaunchTerminalError)
  ) {
    return settlement
  }
  const chat = declinedChat(args, worktreeId, tab)
  if (!chat) {
    return settlement
  }
  const { outcome } = settlement.error.result
  const pane = outcome.kind === 'terminal' && outcome.paneKey ? parsePaneKey(outcome.paneKey) : null
  const deadline = Date.now() + HOST_TERMINAL_DRAWN_WITHIN_MS
  const terminalTabId = pane
    ? await awaitWhileChatHeld(args, worktreeId, tab, chat, deadline, () =>
        workspaceTerminalForHostTab(
          useAppStore.getState().unifiedTabsByWorktree[worktreeId],
          pane.tabId
        )
      )
    : undefined
  // A held message the host gave no receipt for, and the composer could not take back, is still
  // only in the launch: the chat keeps it beside the terminal.
  const owed = chat.launchState?.intent.opening !== undefined
  return replaceDeclinedChat(
    args,
    worktreeId,
    tab,
    owed ? { ...chat, typed: true } : chat,
    terminalTabId,
    settlement,
    // Placed by main is not yet drawn here: the chat gives way once this window shows the move.
    (placed) =>
      awaitWhileChatHeld(args, worktreeId, tab, chat, deadline, () => placed() || undefined)
  )
}

/** A launch read again after an unknown answer or a reload has no caller left waiting on it: its
 *  shown chat gives way to the terminal the host reports, as it does at launch. */
export function adoptRereadHostLaunchTerminal(state: StructuredLaunchState): void {
  const { promise, intent } = state
  void promise.catch((error: unknown) => {
    const tab = findStructuredLaunchTab(intent)
    if (
      !(error instanceof StructuredHostLaunchTerminalError) ||
      state.promise !== promise ||
      !tab
    ) {
      return
    }
    void adoptHostLaunchedTerminal(
      { plan: { agent: intent.agent }, hooks: {} },
      intent.worktreeId,
      tab,
      { kind: 'failed', error }
    )
  })
}
