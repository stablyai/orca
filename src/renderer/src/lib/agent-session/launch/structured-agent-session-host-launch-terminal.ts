/** A host launch that started its terminal instead of the chat: the chat's tab gives way to that
 *  terminal once this window draws it, in the place a declined chat's terminal takes. */

import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toHostSessionTabId
} from '../../../../../shared/terminal-surface-id'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import { useAppStore } from '@/store/index'
import type { OpenedAgentSessionTab } from '../../structured-agent-session-tab-open-through-layout-owner'
import type { ProvisionalLaunchArgs } from '../structured-agent-session-provisional-tab'
import { declinedChat, replaceDeclinedChat } from './structured-agent-session-action-launch'
import { StructuredHostLaunchTerminalError } from './structured-agent-session-host-launch'

// The host's reveal reaches this window a moment after its answer; past this the chat stays and
// says the terminal opened where it could not be shown.
const HOST_TERMINAL_DRAWN_WITHIN_MS = 10_000

function drawnTerminalTabId(worktreeId: string, hostTabId: string): string | undefined {
  // A paired host's terminal is drawn under a mirrored id that decodes to the host's tab.
  const isHostTab = (id: string): boolean =>
    toHostSessionTabId(id).split(HOST_TERMINAL_SURFACE_SEPARATOR)[0] === hostTabId
  return (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) =>
      candidate.contentType === 'terminal' &&
      (isHostTab(candidate.id) || isHostTab(candidate.entityId))
  )?.id
}

function awaitDrawnTerminalTab(worktreeId: string, hostTabId: string): Promise<string | undefined> {
  const drawn = drawnTerminalTabId(worktreeId, hostTabId)
  if (drawn) {
    return Promise.resolve(drawn)
  }
  return new Promise((resolve) => {
    let unsubscribe = (): void => {}
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(undefined)
    }, HOST_TERMINAL_DRAWN_WITHIN_MS)
    unsubscribe = useAppStore.subscribe(() => {
      const id = drawnTerminalTabId(worktreeId, hostTabId)
      if (id) {
        clearTimeout(timer)
        unsubscribe()
        resolve(id)
      }
    })
  })
}

/** Driven by the host's own result, never by a refusal: the terminal already exists. */
export async function adoptHostLaunchedTerminal(
  args: ProvisionalLaunchArgs,
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
  const terminalTabId = pane ? await awaitDrawnTerminalTab(worktreeId, pane.tabId) : undefined
  return replaceDeclinedChat(args, worktreeId, tab, chat, terminalTabId, settlement)
}
