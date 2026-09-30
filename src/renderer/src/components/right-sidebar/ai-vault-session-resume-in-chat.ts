// Whether an Agent Session History row can be resumed into a structured native chat, and where.
//
// Separate from `ai-vault-session-resume.ts` because the answer is not the same question: the
// terminal resume asks whether a workspace can host a PTY, this asks whether a provider will still
// find the conversation from the workspace we would run it in.

import { isWslStoredAiVaultSessionFile } from '@/lib/ai-vault-resume-target'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
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

export type AiVaultResumeInChatEligibility =
  | { available: true; workspaceId: string }
  | { available: false; reason: AiVaultResumeInChatBlockedReason }

/**
 * Claude and Codex do not have the same freedom about *where* a conversation may be resumed.
 *
 * Codex is handed the rollout file and a cwd, so it can resume into any workspace. Claude's SDK
 * stores transcripts under a project key derived from the launch cwd, so resuming from a workspace
 * other than the one the conversation was recorded in looks in a directory the transcript is not in.
 * That is a resume that silently yields nothing, which is worse than a disabled affordance.
 */
export function aiVaultSessionResumeInChatWorkspaceMatters(
  agent: AiVaultSession['agent']
): boolean {
  return agent === 'claude'
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
  /** The route the same (workspace, agent) pair would take for a fresh chat. Reused rather than
   *  re-derived: it already encodes the settings flag, host capability, platform refusals and the
   *  WSL/repair refusal, and a second copy of those conditions would drift from it. */
  structuredRouteAvailable: boolean
}): AiVaultResumeInChatEligibility {
  const { session } = args
  if (!isAgentSessionHandleProvider(session.agent)) {
    return { available: false, reason: 'agent' }
  }
  // An already-adopted row reopens its own chat instead; offering a second resume of it would ask
  // for a conflict the host would rightly refuse.
  if (session.structuredSession) {
    return { available: false, reason: 'already-structured' }
  }
  if (
    session.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    isWslStoredAiVaultSessionFile(session.filePath)
  ) {
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
  return { available: true, workspaceId: args.targetWorkspaceId }
}
