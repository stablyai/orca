import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { findTerminalTabWorktreeId } from '@/components/native-chat/native-chat-file-link'
import { getNativeChatSessionTransport } from '@/components/native-chat/native-chat-session-transport'
import { resolvePaneAgentSessionId } from '@/components/terminal-pane/pane-agent-session-id'
import type { AppState } from '@/store/types'
import {
  getKnownExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'

const TRANSCRIPT_ANCHOR_READ_LIMIT = 40

type PromptCacheTranscriptSource = {
  sessionId: string
  transcriptPath?: string
  worktreeId: string
}

/**
 * Time of the last API request. A prompt or tool result is sent the moment it is
 * written, so the newest one is that request; a reply only lands after its generation
 * time and is used when the tail holds no request. Interruption notices are never sent.
 */
export function lastRequestTimestamp(messages: readonly NativeChatMessage[]): number | null {
  let latestRequest: number | null = null
  let latestReply: number | null = null
  for (const message of messages) {
    if (message.timestamp === null || message.role === 'system') {
      continue
    }
    if (message.role === 'user' || message.role === 'tool') {
      latestRequest = Math.max(latestRequest ?? message.timestamp, message.timestamp)
    } else {
      latestReply = Math.max(latestReply ?? message.timestamp, message.timestamp)
    }
  }
  return latestRequest ?? latestReply
}

/**
 * The Claude session a pane's countdown belongs to, when its transcript is readable
 * through the native chat transport. SSH panes are skipped: their transcript lives on
 * the remote machine, and a same-path local file is not that session.
 */
export function resolvePromptCacheTranscriptSource(
  state: AppState,
  paneKey: string
): PromptCacheTranscriptSource | null {
  const tabId = parsePaneKey(paneKey)?.tabId
  const sessionId = tabId ? resolvePaneAgentSessionId(state, paneKey) : null
  if (!tabId || !sessionId) {
    return null
  }
  const row = state.agentStatusByPaneKey[paneKey]
  if (row?.providerSession?.id === sessionId) {
    const worktreeId = row.worktreeId ?? findTerminalTabWorktreeId(state.tabsByWorktree, tabId)
    if (row.agentType !== 'claude' || (row.connectionId ?? null) !== null || !worktreeId) {
      return null
    }
    return transcriptSource(state, row.providerSession, worktreeId)
  }
  const record = state.sleepingAgentSessionsByPaneKey[paneKey]
  if (
    record?.providerSession.id !== sessionId ||
    record.agent !== 'claude' ||
    (record.connectionId ?? null) !== null
  ) {
    return null
  }
  return transcriptSource(state, record.providerSession, record.worktreeId)
}

function transcriptSource(
  state: AppState,
  session: AgentProviderSessionMetadata,
  worktreeId: string
): PromptCacheTranscriptSource | null {
  if (session.key !== 'session_id') {
    return null
  }
  // Why: SSH orphan records can carry no connectionId, so the worktree's host decides too.
  if (parseExecutionHostId(getKnownExecutionHostIdForWorktree(state, worktreeId))?.kind === 'ssh') {
    return null
  }
  return {
    sessionId: session.id,
    ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
    worktreeId
  }
}

async function readLastRequestTimestamp(
  state: AppState,
  source: PromptCacheTranscriptSource
): Promise<number | null> {
  const transport = getNativeChatSessionTransport(
    getRuntimeEnvironmentIdForWorktree(state, source.worktreeId)
  )
  try {
    const result = await transport.readSession(
      'claude',
      source.sessionId,
      TRANSCRIPT_ANCHOR_READ_LIMIT,
      source.transcriptPath
    )
    return 'error' in result ? null : lastRequestTimestamp(result.messages)
  } catch {
    // Why: an unreadable transcript keeps the countdown as started.
    return null
  }
}

/**
 * Moves a freshly started countdown back to the session's last API request.
 * Sleep, restart, and `--resume` start the countdown without a request, so the
 * cache is older than the countdown claims. Only ever moves the start earlier.
 */
export async function anchorPromptCacheTimerToTranscript(args: {
  paneKey: string
  startedAt: number
  getState: () => AppState
  applyAnchor: (anchoredAt: number) => void
}): Promise<void> {
  const state = args.getState()
  const source = resolvePromptCacheTranscriptSource(state, args.paneKey)
  if (!source) {
    return
  }
  const anchoredAt = await readLastRequestTimestamp(state, source)
  if (anchoredAt === null || anchoredAt >= args.startedAt) {
    return
  }
  // Why: a new turn or pane exit during the read owns the countdown now.
  if (args.getState().cacheTimerByKey[args.paneKey] !== args.startedAt) {
    return
  }
  args.applyAnchor(anchoredAt)
}
