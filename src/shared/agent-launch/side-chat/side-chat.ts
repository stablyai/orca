import type { AgentProviderSessionMetadata } from '../../agent-session/lifecycle/agent-session-resume'
import { isClaudeSideChatSessionId } from './claude-side-chat-session-id'
import { isOmpSideChatTranscriptPath } from './omp-side-chat-session'

/** Agents whose terminal panes can open a Codex-style side chat. */
export type SideChatAgent = 'claude' | 'omp'

export function isSideChatAgent(agent: string | null | undefined): agent is SideChatAgent {
  return agent === 'claude' || agent === 'omp'
}

/** Side chats are ephemeral forks, so nothing may resume, fork, or hibernate one. */
export function isSideChatProviderSession(
  agent: string | null | undefined,
  session: Pick<AgentProviderSessionMetadata, 'id' | 'transcriptPath'> | null | undefined
): boolean {
  if (!session) {
    return false
  }
  if (agent === 'claude') {
    return isClaudeSideChatSessionId(session.id)
  }
  return agent === 'omp' && isOmpSideChatTranscriptPath(session.transcriptPath)
}

// Why no apostrophes, backslashes or newlines: Claude's hook echoes it single-quoted from sh, Git Bash and PowerShell alike.
export const SIDE_CHAT_CONTEXT = [
  'Side conversation boundary.',
  'Everything before this point is inherited history from the main session, which runs in another Orca pane and may still be working.',
  'It is reference context only, not your current task.',
  'Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this point.',
  'Only messages the user sends after this point are active instructions for this side conversation.',
  'You are a side-conversation assistant, separate from the main session.',
  'Answer questions and do lightweight, non-mutating exploration such as reading or searching files and running read-only checks, without disrupting the main session.',
  'If there is no user question yet, wait for one.',
  'Do not modify files, source, git state, permissions, configuration, or other workspace state unless the user explicitly asks for that mutation in this side conversation; if they do, keep it minimal and local to the request.',
  'Do not start subagents, background tasks, or new worktrees here; point such requests back to the main session.',
  'This side conversation is temporary and is discarded when its pane closes.'
].join(' ')

export type SideChatStartup = { command: string; env?: Record<string, string> }
