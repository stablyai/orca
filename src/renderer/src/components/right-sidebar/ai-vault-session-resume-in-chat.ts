import { isAntigravityReferenceSession } from '../../../../shared/antigravity-session-origin'
import { canOpenAiVaultSessionHistoryChat } from './ai-vault-session-history-chat'
// Whether an Agent Session History row can be resumed into a structured native chat, and where.
//
// Separate from `ai-vault-session-resume.ts` because the answer is not the same question: the
// terminal resume asks whether a workspace can host a PTY, this asks whether a provider will still
// find the conversation from the workspace we would run it in.

import { isWslStoredAiVaultSessionFile } from '@/lib/ai-vault-resume-target'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { adoptsCliConversations } from '../../../../shared/structured-agent-cli-conversation-adoption'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'

export type AiVaultResumeInChatBlockedReason =
  | 'agent'
  | 'remote'
  | 'empty'
  | 'already-structured'
  | 'workspace'

export type AiVaultResumeInChatRoute = 'structured' | 'history'

export type AiVaultResumeInChatEligibility =
  | { available: true; workspaceId: string; route: AiVaultResumeInChatRoute }
  | { available: false; reason: AiVaultResumeInChatBlockedReason }

/**
 * Agents do not have the same freedom about *where* a conversation may be resumed.
 *
 * Codex is handed the rollout file and a cwd, so it can resume into any workspace. Claude, Grok and
 * OMP store conversations under a folder derived from the launch cwd, so resuming from a workspace
 * other than the one the conversation was recorded in looks in a folder the conversation is not in,
 * OpenCode refuses a conversation that does not belong to the launch cwd, and a Pi chat forks a
 * conversation recorded elsewhere into a copy instead of taking it over.
 * That is a resume that silently yields nothing, which is worse than a disabled affordance.
 */
export function aiVaultSessionResumeInChatWorkspaceMatters(
  agent: AiVaultSession['agent']
): boolean {
  return (
    agent === 'claude' ||
    agent === 'grok' ||
    agent === 'omp' ||
    agent === 'opencode' ||
    agent === 'opencode2' ||
    agent === 'pi'
  )
}

/**
 * Does the row's recorded directory name the same place as the target workspace?
 *
 * Uses the shared runtime-path comparison rather than a local normalizer, which also keeps POSIX
 * paths case-SENSITIVE — folding their case would call two genuinely different directories the same.
 */
export function aiVaultSessionCwdMatchesWorkspace(
  cwd: string | null | undefined,
  workspacePath: string | null | undefined
): boolean {
  if (!cwd || !workspacePath) {
    return false
  }
  return (
    normalizeRuntimePathForComparison(cwd.trim()) ===
    normalizeRuntimePathForComparison(workspacePath.trim())
  )
}

export function resolveAiVaultSessionResumeInChatEligibility(args: {
  session: Pick<
    AiVaultSession,
    'agent' | 'cwd' | 'filePath' | 'executionHostId' | 'messageCount' | 'previewMessages'
  > & { structuredSession?: AiVaultSession['structuredSession'] }
  targetWorkspaceId: string | null
  targetWorkspacePath: string | null
  /** Whether the same (workspace, agent) pair can host a structured chat; the Chat UI switch does
   *  not apply. Reused rather than re-derived: it already encodes host capability, platform refusals
   *  and the WSL/repair refusal, and a second copy of those conditions would drift from it. */
  structuredRouteAvailable: boolean
}): AiVaultResumeInChatEligibility {
  const { session } = args
  if (isAntigravityReferenceSession(session) || !adoptsCliConversations(session.agent)) {
    return { available: false, reason: 'agent' }
  }
  // An already-adopted row reopens its own chat instead; offering a second resume of it would ask
  // for a conflict the host would rightly refuse.
  if (session.structuredSession) {
    return { available: false, reason: 'already-structured' }
  }
  // A ZCode row rides two paths: an unadopted local conversation adopts into the live structured
  // chat like Claude's and Codex's (its transcript proof is the provider's SQLite store, checked by
  // the host at create), while a conversation the host cannot adopt — one whose database is stored
  // inside WSL, which no local app-server child can open — keeps the read-only history tab.
  const isZcodeRow = canOpenAiVaultSessionHistoryChat(session)
  const route: AiVaultResumeInChatRoute = isZcodeRow
    ? zcodeAdoptionAvailable(session) && args.structuredRouteAvailable
      ? 'structured'
      : 'history'
    : 'structured'
  // The history tab needs no host adoption — the conversation renders from the agent's own store —
  // so the structured-route questions do not apply to it, only the storage ones.
  if (route === 'history') {
    if (session.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return { available: false, reason: 'remote' }
    }
    if (!isAiVaultSessionResumableContent(session)) {
      return { available: false, reason: 'empty' }
    }
    if (!args.targetWorkspaceId) {
      return { available: false, reason: 'workspace' }
    }
    return { available: true, workspaceId: args.targetWorkspaceId, route }
  }
  if (session.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return { available: false, reason: 'remote' }
  }
  // A structured host reads the conversation through a reader on this machine, so a transcript
  // stored inside WSL is as out of reach here as one on a remote host (ZCode's read-only path
  // already routed those rows to 'history' above).
  if (isWslStoredAiVaultSessionFile(session.filePath)) {
    return { available: false, reason: 'remote' }
  }
  if (!isAiVaultSessionResumableContent(session)) {
    return { available: false, reason: 'empty' }
  }
  if (!args.targetWorkspaceId || !args.structuredRouteAvailable) {
    return { available: false, reason: 'workspace' }
  }
  if (
    aiVaultSessionResumeInChatWorkspaceMatters(session.agent) &&
    !aiVaultSessionCwdMatchesWorkspace(session.cwd, args.targetWorkspacePath)
  ) {
    return { available: false, reason: 'workspace' }
  }
  return { available: true, workspaceId: args.targetWorkspaceId, route }
}

/** Whether this ZCode row's storage lets a structured host on this machine adopt it: the
 *  conversation must live in a database the app-server child can open, which a WSL-stored
 *  database is not (the child runs on the host OS; `session/resume` would find nothing). */
function zcodeAdoptionAvailable(session: {
  executionHostId: AiVaultSession['executionHostId']
  filePath: AiVaultSession['filePath']
}): boolean {
  return (
    session.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    !isWslStoredAiVaultSessionFile(session.filePath)
  )
}
