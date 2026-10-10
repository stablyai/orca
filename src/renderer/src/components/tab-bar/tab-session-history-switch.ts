// Resolves a tab to its Agent Session History row, so the tab menu offers the same "Resume in New
// Native Chat" / "Resume in New CLI" move the row menu does, under the row menu's gating.

import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { collectAiVaultTitleRequests } from '@/lib/ai-vault-tab-title-requests'
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
  isAgentSessionHandleProvider,
  type AgentSessionHandleProvider
} from '../../../../shared/agent-session-provider-handle'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveAiVaultSessionSurfaceSwitchTargets } from '../right-sidebar/ai-vault-session-surface-switch'
import { resolveAiVaultHistoryRowResume } from '../right-sidebar/ai-vault-session-resume-in-chat-workspace'
import { resolveAiVaultTargetWorkspacePath } from '../right-sidebar/ai-vault-session-launch-target'
import { resolveAiVaultSessionWorktreeDisplay } from '../right-sidebar/ai-vault-session-worktree'
import {
  aiVaultSessionListArgs,
  type AiVaultSessionListRequest
} from '../right-sidebar/ai-vault-session-list-request'
import { resolveAiVaultPanelSessionListRequest } from '../right-sidebar/ai-vault-panel-session-list-request'
import { claimAiVaultForcedRescan } from '../right-sidebar/ai-vault-session-refresh'

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
      agent: AgentSessionHandleProvider
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

export function resolveTabSessionHistorySubject(
  state: AppState,
  args: {
    tab: Pick<TerminalTab, 'id' | 'worktreeId' | 'launchAgent'>
    /** Set only for a native chat tab: the chat session it shows. */
    structuredSessionId?: string
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
  if (args.structuredSessionId !== undefined) {
    // Only these providers have history rows either move can act on.
    const target = isAgentSessionHandleProvider(args.tab.launchAgent)
      ? workspace(args.tab.worktreeId, 'chat')
      : null
    return target ? { ...target, kind: 'chat', sessionId: args.structuredSessionId } : null
  }
  // The same pane-to-conversation mapping tab titles use: live agent, then sleeping, then retained.
  const titleRequest = collectAiVaultTitleRequests(state).find(
    (candidate) => candidate.tabId === args.tab.id
  )
  const target = titleRequest ? workspace(titleRequest.worktreeId, 'cli') : null
  return titleRequest && target
    ? {
        ...target,
        kind: 'cli',
        agent: titleRequest.agent,
        providerSessionId: titleRequest.providerSession.id
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
      return (
        !session.structuredSession &&
        session.agent === subject.agent &&
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
  const worktrees = getIndexedAllWorktrees(state.worktreesByRepo)
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
  options: { requestToken: string; isCancelled: () => boolean }
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
    !claimAiVaultForcedRescan()
  ) {
    return row
  }
  const fresh = await listSessions(aiVaultSessionListArgs(request, { force: true, requestToken }))
  if (fresh.cancelled) {
    return undefined
  }
  return findTabSessionHistoryRow(fresh.sessions, subject)
}
