// Open a located sender: its chat, its pane through the sidebar's path when this window holds the
// tab, else that same pane through its host. Never whatever the card's saved address names now.

import { toast } from 'sonner'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeTerminalResolvePane } from '../../../shared/runtime-terminal-contracts'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  focusRendererTerminalHandle,
  focusRuntimeTerminalHandle
} from '@/components/terminal-pane/terminal-handle-links'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/stale-agent-row'
import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'
import type { LocatedAgentSender } from '@/runtime/agent-sender-associations'
import {
  agentMessageSenderUnavailableText,
  type AgentMessageSenderTarget
} from '@/components/native-chat/native-chat-agent-message-sender-target'
import { activateWorktreeAgentPane } from '@/components/sidebar/use-worktree-agent-activation'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'

/** older-host identifies the chat host; update may mean either side, and unreachable proves nothing. */
export type LookupFailure = 'older-host' | 'update' | 'unreachable'
/** The click's own resolution, read again after an asynchronous step, and a fresh click. */
type Click = { current: () => AgentMessageSenderTarget; reopen: () => Promise<void> }

/** The answers that prove the terminal is gone; anything else proves nothing about it. */
const TERMINAL_GONE_CODES = new Set([
  'terminal_exited',
  'terminal_gone',
  'terminal_handle_stale',
  'terminal_not_found'
])
/** A host names a missing terminal by code, or by message under runtime_error as its runtime throws. */
const provesTerminalGone = (error: unknown) =>
  error instanceof RuntimeRpcCallError &&
  (TERMINAL_GONE_CODES.has(error.code) || TERMINAL_GONE_CODES.has(error.message))

export function openLocatedAgentMessageSender(
  location: LocatedAgentSender,
  name: string,
  click: Click
): Promise<void> {
  if (location.sessionId) {
    return openLocatedChat(location, location.sessionId)
  }
  const tabId = heldTabId(useAppStore.getState(), location)
  if (tabId) {
    activateWorktreeAgentPane(location.worktreeId, tabId, location.paneKey)
    return Promise.resolve()
  }
  return openUnheldTerminal(location, name, click)
}

/** The located chat itself, through the same activation its sidebar row uses. */
async function openLocatedChat(location: LocatedAgentSender, sessionId: string): Promise<void> {
  const host = structuredAgentSessionTargetForHost(location.host)
  if (!host) {
    showLookupFailure('unreachable')
    return
  }
  const session = {
    structuredSession: { workspaceId: location.worktreeId, sessionId }
  }
  await activateAiVaultStructuredSession(session, undefined, host)
}

/** The tab the sidebar activation opens for the located pane, when this window holds one. */
function heldTabId(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  location: LocatedAgentSender
): string | null {
  const tabId = parsePaneKey(location.paneKey)?.tabId
  if (!tabId) {
    return null
  }
  const held =
    (state.tabsByWorktree[location.worktreeId] ?? []).some((tab) => tab.id === tabId) ||
    (state.unifiedTabsByWorktree[location.worktreeId] ?? []).some(
      (tab) => tab.id === tabId && tab.contentType === 'agent-session'
    )
  return held ? tabId : null
}

/** The handle the located pane holds: its status row's, when that row is known to be this pane's
 *  on this host, else the host's answer for the pane itself. */
async function openUnheldTerminal(
  location: LocatedAgentSender,
  name: string,
  click: Click
): Promise<void> {
  const host = structuredAgentSessionTargetForHost(location.host)
  if (!host) {
    showLookupFailure('unreachable')
    return
  }
  const environmentId = host.kind === 'environment' ? host.environmentId : null
  const gone = () =>
    toast.info(agentMessageSenderUnavailableText({ kind: 'gone', sender: 'terminal' }, name))
  const row = useAppStore.getState().agentStatusByPaneKey[location.paneKey]
  let handle =
    row?.worktreeId === location.worktreeId && (row.connectionId ?? null) === environmentId
      ? row.terminalHandle
      : undefined
  if (!handle) {
    try {
      const { terminal } = await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
        host,
        'terminal.resolvePane',
        { paneKey: location.hostPaneKey, worktreeId: location.worktreeId }
      )
      handle = terminal.handle
    } catch (error) {
      if (provesTerminalGone(error)) {
        gone()
      } else {
        showLookupFailure(isRuntimeCompatBlockError(error) ? 'update' : 'unreachable')
      }
      return
    }
    // The card may have changed while the host answered: act on what it names now instead.
    const now = click.current()
    if (
      now.kind !== 'located' ||
      now.location.host !== location.host ||
      now.location.hostPaneKey !== location.hostPaneKey
    ) {
      return click.reopen()
    }
  }
  await focusTerminal(handle, environmentId, gone)
}

export async function focusTerminal(
  handle: string,
  environmentId: string | null,
  gone: () => void = showAgentPaneUnavailable
): Promise<void> {
  if (focusRendererTerminalHandle(handle, environmentId)) {
    return
  }
  try {
    await focusRuntimeTerminalHandle(handle, environmentId)
  } catch (error) {
    if (provesTerminalGone(error)) {
      gone()
    } else {
      showLookupFailure(isRuntimeCompatBlockError(error) ? 'update' : 'unreachable')
    }
  }
}

export function showLookupFailure(failure: LookupFailure): void {
  toast.error(
    agentSessionWriteNoticeText(
      failure === 'older-host'
        ? ['unsupported']
        : failure === 'update'
          ? ['updateOrcaToOpenChat']
          : ['unreachable', 'tryAgain']
    )
  )
}
