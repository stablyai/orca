// Resolves a tab to its Agent Session History row so both menus offer the same surface switches.

import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import {
  collectAgentPaneConversations,
  resolvePaneAgentConversation
} from '@/lib/ai-vault-tab-title-requests'
import {
  isAiVaultSessionResumableContent,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import {
  adoptsCliConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS,
  cliConversationRowsShareAgent,
  type CliConversationRowAgent
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { agentForksConversations } from '../../../../shared/agent-resume-argv'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import { resolveAiVaultSessionSurfaceSwitchTargets } from '../right-sidebar/ai-vault-session-surface-switch'
import { resolveAiVaultHistoryRowResume } from '../right-sidebar/ai-vault-session-resume-in-chat-workspace'
import { resolveAiVaultTargetWorkspacePath } from '../right-sidebar/ai-vault-session-launch-target'
import {
  aiVaultSessionOwnerWorkspaces,
  resolveAiVaultSessionWorktreeDisplay
} from '../right-sidebar/ai-vault-session-worktree'
import {
  aiVaultSessionListArgs,
  type AiVaultSessionListRequest
} from '../right-sidebar/ai-vault-session-list-request'
import { resolveAiVaultPanelSessionListRequest } from '../right-sidebar/ai-vault-panel-session-list-request'
import { resolveAiVaultHostScopeDefaults } from '../right-sidebar/ai-vault-host-scope'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import { claimAiVaultForcedRescan } from '../right-sidebar/ai-vault-session-refresh'
import { structuredAgentSessionLaunchFeasible } from '@/lib/agent-session-launch-plan'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { workspaceKindForWorktreeId } from '../../../../shared/workspace-launch-kind'

/** What a tab's history row is found by: a native chat tab by the chat it shows, a terminal tab by
 *  the provider conversation its agent reported. */
export type TabSessionHistorySubject = {
  workspaceId: string
  /** The panel's own list request for this workspace, so both share one cached list. */
  request: AiVaultSessionListRequest
} & (
  | { kind: 'chat'; sessionId: string }
  | {
      kind: 'cli'
      agent: CliConversationRowAgent
      providerSessionId: string
    }
)

export type TabSessionSwitch = {
  action: 'resume-in-new-chat' | 'resume-in-new-cli'
  worktreeId: string
}

/** Skips lookups on hosts where the row's gate can never pass, so no remote scan runs for nothing. */
function canHostOfferTabSessionMove(
  kind: TabSessionHistorySubject['kind'],
  hostScope: ExecutionHostScope
): boolean {
  if (hostScope === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  // Resume-in-chat refuses any row not recorded on this machine. A chat's row is owned only where an
  // Orca host projects chat ownership: this machine or a runtime server, never an SSH relay.
  return kind === 'chat' && parseExecutionHostId(hostScope)?.kind === 'runtime'
}

/** The pane's known identity and launch route, without a History request. */
export function canPaneOfferResumeInNewChat(
  state: AppState,
  pane: { worktreeId: string; paneKey: string }
): boolean {
  const conversation = resolvePaneAgentConversation(state, pane, adoptsCliConversations)
  if (!conversation) {
    return false
  }
  const hostScope = resolveAiVaultHostScopeDefaults(
    getAiVaultResumeWorkspaceExecutionHostId(state, conversation.worktreeId),
    conversation.worktreeId
  ).defaultExecutionHostScope
  // The row gate's launch-route half, so a project the chat route refuses (WSL, repair) hides it.
  return (
    canHostOfferTabSessionMove('cli', hostScope) &&
    CLI_CONVERSATION_ADOPTING_AGENTS[conversation.agent].some((agent) =>
      structuredAgentSessionLaunchFeasible(state, {
        agent,
        workspace: {
          kind: workspaceKindForWorktreeId(conversation.worktreeId),
          worktreeId: conversation.worktreeId
        },
        settings: state.settings
      })
    )
  )
}

/** A native chat tab's session and the provider recorded when it was created. */
export type NativeChatTabSession = {
  sessionId: string
  agent: AgentType | undefined
}

export type NativeChatCliForkIdentity = {
  workspaceId: string
  sessionId: string
  executionHostScope: ExecutionHostScope
}

export function resolveNativeChatCliForkIdentity(
  state: AppState,
  args: { tab: Pick<TerminalTab, 'id' | 'worktreeId'>; nativeChat: NativeChatTabSession }
): NativeChatCliForkIdentity | null {
  const { nativeChat, tab } = args
  if (
    !nativeChat.agent ||
    !agentForksConversations(nativeChat.agent) ||
    !resolveAiVaultTargetWorkspacePath(state, tab.worktreeId)
  ) {
    return null
  }
  const executionHostScope = resolveAiVaultHostScopeDefaults(
    getAiVaultResumeWorkspaceExecutionHostId(state, tab.worktreeId),
    tab.worktreeId
  ).defaultExecutionHostScope
  return canHostOfferTabSessionMove('chat', executionHostScope)
    ? { workspaceId: tab.worktreeId, sessionId: nativeChat.sessionId, executionHostScope }
    : null
}

export function resolveTabSessionHistorySubject(
  state: AppState,
  args: {
    tab: Pick<TerminalTab, 'id' | 'worktreeId'>
    /** Set only for a native chat tab. */
    nativeChat?: NativeChatTabSession
    /** Narrows a terminal tab to one pane's own conversation instead of the tab's best one. */
    paneKey?: string
  }
): TabSessionHistorySubject | null {
  const workspace = (workspaceId: string, kind: TabSessionHistorySubject['kind']) => {
    if (!resolveAiVaultTargetWorkspacePath(state, workspaceId)) {
      return null
    }
    const request = resolveAiVaultPanelSessionListRequest(state, workspaceId)
    return canHostOfferTabSessionMove(kind, request.executionHostScope)
      ? { workspaceId, request }
      : null
  }
  if (args.nativeChat) {
    // A chat tab's only move is opening a copy in its CLI.
    const identity = resolveNativeChatCliForkIdentity(state, {
      ...args,
      nativeChat: args.nativeChat
    })
    return identity
      ? {
          kind: 'chat',
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          request: resolveAiVaultPanelSessionListRequest(state, identity.workspaceId)
        }
      : null
  }
  // The pane-to-conversation mapping tab titles use, for the agents a chat can take over, limited to
  // agents still running: once the agent exits, the tab title keeps its conversation but the move is
  // no longer offered.
  const conversation = args.paneKey
    ? resolvePaneAgentConversation(
        state,
        { worktreeId: args.tab.worktreeId, paneKey: args.paneKey },
        adoptsCliConversations
      )
    : (collectAgentPaneConversations(state, adoptsCliConversations, {
        runningAgentsOnly: true
      }).find((candidate) => candidate.tabId === args.tab.id) ?? null)
  const target = conversation ? workspace(conversation.worktreeId, 'cli') : null
  return conversation && target
    ? {
        ...target,
        kind: 'cli',
        agent: conversation.agent,
        providerSessionId: conversation.providerSession.id
      }
    : null
}

export function findTabSessionHistoryRow(
  sessions: readonly AiVaultSession[],
  subject: TabSessionHistorySubject
): AiVaultSession | null {
  return (
    sessions.find((session) => {
      if (session.subagent) {
        return false
      }
      if (subject.kind === 'chat') {
        return session.structuredSession?.sessionId === subject.sessionId
      }
      // A chat-owned row still matches: the move's gate refuses it, and the caller can open that chat.
      // By the chats that take it over: an OpenCode 2.x pane reports `opencode`, its row `opencode2`.
      return (
        adoptsCliConversations(session.agent) &&
        cliConversationRowsShareAgent(session.agent, subject.agent) &&
        session.sessionId === subject.providerSessionId
      )
    }) ?? null
  )
}

/** The row's move under the Session History gate, with the tab's own workspace standing in for the
 *  active one. A chat tab only forks into a CLI; a CLI tab only resumes into a chat. */
export function resolveTabSessionSwitch(
  state: AppState,
  session: AiVaultSession,
  subject: TabSessionHistorySubject
): TabSessionSwitch | null {
  const worktrees = aiVaultSessionOwnerWorkspaces(
    getIndexedAllWorktrees(selectWorktreesByRepo(state)),
    selectFolderWorkspaces(state)
  )
  const { resumeState, resumeInChat } = resolveAiVaultHistoryRowResume({
    session,
    worktreeInfo: resolveAiVaultSessionWorktreeDisplay({
      session,
      repos: state.repos,
      worktrees,
      activeWorktreeId: subject.workspaceId
    }),
    activeWorktreeId: subject.workspaceId,
    worktrees,
    repos: state.repos,
    targetState: state,
    settings: state.settings
  })
  const targets = resolveAiVaultSessionSurfaceSwitchTargets(session, resumeState, resumeInChat)
  if (subject.kind === 'chat') {
    return targets.resumeInNewCliWorktreeId
      ? {
          action: 'resume-in-new-cli',
          worktreeId: targets.resumeInNewCliWorktreeId
        }
      : null
  }
  return targets.resumeInNewChatWorkspaceId
    ? {
        action: 'resume-in-new-chat',
        worktreeId: targets.resumeInNewChatWorkspaceId
      }
    : null
}

/** Reads the row through the panel's own list request. It never uses the panel's renderer cache:
 *  cached rows miss chat ownership the host projects per reply, and a write here would let a
 *  later-opened panel paint this pre-launch list without asking the host.
 *  Resolves `undefined` when it got no answer (cancelled), as opposed to `null` for "no row". */
export async function lookupTabSessionHistoryRow(
  subject: TabSessionHistorySubject,
  listSessions: (args: AiVaultListArgs) => Promise<AiVaultListResult>,
  options: {
    requestToken: string
    isCancelled: () => boolean
    /** A click made for this lookup alone may force a scan the way the panel's Refresh does. */
    userRequested?: boolean
  }
): Promise<AiVaultSession | null | undefined> {
  const { request } = subject
  const { requestToken } = options
  const listed = await listSessions(aiVaultSessionListArgs(request, { requestToken }))
  if (listed.cancelled) {
    return undefined
  }
  const row = findTabSessionHistoryRow(listed.sessions, subject)
  if (row && isAiVaultSessionResumableContent(row)) {
    return row
  }
  // The host caches the list for a minute, so a conversation newer than that needs a fresh scan,
  // taken from the panel's forced-rescan budget so right-clicks cannot amplify full scans. A closed
  // menu checks first: its cancel may have landed before this scan was registered.
  if (
    options.isCancelled() ||
    request.executionHostScope !== LOCAL_EXECUTION_HOST_ID ||
    !claimAiVaultForcedRescan(options.userRequested === true)
  ) {
    return row
  }
  const fresh = await listSessions(aiVaultSessionListArgs(request, { force: true, requestToken }))
  if (fresh.cancelled) {
    return undefined
  }
  return findTabSessionHistoryRow(fresh.sessions, subject)
}
