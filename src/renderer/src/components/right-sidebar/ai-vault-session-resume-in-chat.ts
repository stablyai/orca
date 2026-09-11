// Whether an Agent Session History row can be resumed into a structured native chat, and where.
//
// Separate from `ai-vault-session-resume.ts` because the answer is not the same question: the
// terminal resume asks whether a workspace can host a PTY, this asks whether a provider will still
// find the conversation from the workspace we would run it in.

import { isWslStoredAiVaultSessionFile } from '@/lib/ai-vault-resume-target'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'

export type AiVaultResumeInChatBlockedReason =
  | 'agent'
  | 'remote'
  /** Both ends could adopt, but they are not the same machine. */
  | 'owner-mismatch'
  /** The owning host predates `resumeFrom` on `agentSession.create`. */
  | 'resume-history'
  | 'empty'
  | 'already-structured'
  | 'workspace'

/** The subset that compares the row's owner with the workspace's. */
export type AiVaultResumeInChatOwnerBlockedReason = Extract<
  AiVaultResumeInChatBlockedReason,
  'remote' | 'owner-mismatch'
>

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

/**
 * A conversation lives in the transcript store of the machine that recorded it, and only that
 * machine can adopt it: `agentSession.create` derives the transcript file and the account home
 * itself, so a create aimed anywhere else would start a blank session under the adopted name.
 *
 * So the two owners must be the same host, and a mismatch is refused here rather than re-homed —
 * moving a conversation between owners is a different flow with a different answer about the
 * provider credentials it would run under. An `ssh:` host has no client RPC path to a structured
 * session at all, and a WSL-stored transcript is reachable only through a shell into that distro,
 * so both stay plain refusals.
 */
export function aiVaultSessionResumeInChatOwnerBlocker(args: {
  sessionExecutionHostId: string | null | undefined
  sessionFilePath: string | null | undefined
  targetExecutionHostId: string | null | undefined
}): AiVaultResumeInChatOwnerBlockedReason | null {
  if (isWslStoredAiVaultSessionFile(args.sessionFilePath)) {
    return 'remote'
  }
  const source = normalizeExecutionHostId(args.sessionExecutionHostId)
  // Absent names this machine, the same default the workspace owner resolver answers with.
  const target = normalizeExecutionHostId(args.targetExecutionHostId) ?? LOCAL_EXECUTION_HOST_ID
  if (!source || !adoptableExecutionHost(source) || !adoptableExecutionHost(target)) {
    return 'remote'
  }
  return source === target ? null : 'owner-mismatch'
}

function adoptableExecutionHost(executionHostId: string): boolean {
  const kind = parseExecutionHostId(executionHostId)?.kind
  return kind === 'local' || kind === 'runtime'
}

export function resolveAiVaultSessionResumeInChatEligibility(args: {
  session: Pick<
    AiVaultSession,
    'agent' | 'cwd' | 'filePath' | 'executionHostId' | 'messageCount' | 'previewMessages'
  > & { structuredSession?: AiVaultSession['structuredSession'] }
  targetWorkspaceId: string | null
  targetWorkspacePath: string | null
  /** The host that would run the chat. Compared with the row's own owner rather than trusted. */
  targetExecutionHostId: string | null
  /** Whether that host's advertised capabilities include adopting a conversation on create. */
  ownerSupportsResumeHistory: boolean
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
  const ownerBlocker = aiVaultSessionResumeInChatOwnerBlocker({
    sessionExecutionHostId: session.executionHostId,
    sessionFilePath: session.filePath,
    targetExecutionHostId: args.targetExecutionHostId
  })
  if (ownerBlocker) {
    return { available: false, reason: ownerBlocker }
  }
  if (!isAiVaultSessionResumableContent(session)) {
    return { available: false, reason: 'empty' }
  }
  if (!args.targetWorkspaceId || !args.structuredRouteAvailable) {
    return { available: false, reason: 'workspace' }
  }
  // Negotiated, never probed: an older host rejects `resumeFrom` as a schema error a client reads
  // as a refusal, so the action is absent rather than attempted.
  if (!args.ownerSupportsResumeHistory) {
    return { available: false, reason: 'resume-history' }
  }
  if (
    aiVaultSessionResumeInChatWorkspaceMatters(session.agent) &&
    !aiVaultSessionCwdMatchesWorkspace(session.cwd, args.targetWorkspacePath)
  ) {
    return { available: false, reason: 'workspace' }
  }
  return { available: true, workspaceId: args.targetWorkspaceId }
}
