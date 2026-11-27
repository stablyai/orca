import { isAntigravityReferenceSession } from '../../../../../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
// Native resume requires provider conversation lookup, unlike terminal resume's PTY-hosting gate.

import { isWslStoredAiVaultSessionFile } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-target'
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from '../../../../../../shared/file-access/cross-platform-path'
import { parseRoutableExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { adoptsCliConversations } from '../../../../../../shared/agent-session/view/structured-agent-cli-conversation-adoption'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

export type AiVaultResumeInChatBlockedReason =
  | 'agent'
  | 'remote'
  | 'empty'
  | 'already-structured'
  | 'workspace'

export type AiVaultResumeInChatEligibility =
  | { available: true; workspaceId: string }
  | { available: false; reason: AiVaultResumeInChatBlockedReason }

/** Codex can resume anywhere; other providers require the original cwd or silently miss/refuse/fork the conversation. */
export function aiVaultSessionResumeInChatWorkspaceMatters(
  agent: AiVaultSession['agent']
): boolean {
  return (
    agent === 'claude' ||
    // Droid loads a session only in the folder it was saved in.
    agent === 'droid' ||
    agent === 'grok' ||
    // Hermes moves a session into whatever folder loads it.
    agent === 'hermes' ||
    // Kimi's own resume refuses a session saved in another folder.
    agent === 'kimi' ||
    agent === 'omp' ||
    agent === 'opencode' ||
    agent === 'opencode2' ||
    agent === 'pi'
  )
}

/** Where a session's recorded cwd sits in the workspace: the folder itself, a sub-folder (Session
 *  History lists those under the workspace too), or neither. Compare with shared runtime rules;
 *  POSIX case folding would conflate distinct directories. */
export function aiVaultSessionCwdInWorkspace(
  cwd: string | null | undefined,
  workspacePath: string | null | undefined,
  cwdAliases: readonly string[] = []
): 'same' | 'inside' | null {
  if (!cwd || !workspacePath) {
    return null
  }
  const workspace = normalizeRuntimePathForComparison(workspacePath.trim())
  const paths = [cwd, ...cwdAliases].map((path) => normalizeRuntimePathForComparison(path.trim()))
  if (paths.includes(workspace)) {
    return 'same'
  }
  return paths.some(createNormalizedPathInsideOrEqualMatcher(workspacePath.trim()))
    ? 'inside'
    : null
}

export function resolveAiVaultSessionResumeInChatEligibility(args: {
  session: Pick<
    AiVaultSession,
    | 'agent'
    | 'cwd'
    | 'cwdAliases'
    | 'filePath'
    | 'executionHostId'
    | 'messageCount'
    | 'previewMessages'
  > & { structuredSession?: AiVaultSession['structuredSession'] }
  targetWorkspaceId: string | null
  targetWorkspacePath: string | null
  /** Reuse structured route capability/platform/WSL gates to prevent drift; the Chat | CLI choice does not apply. */
  structuredRouteAvailable: boolean
}): AiVaultResumeInChatEligibility {
  const { session } = args
  if (isAntigravityReferenceSession(session) || !adoptsCliConversations(session.agent)) {
    return { available: false, reason: 'agent' }
  }
  // Already-adopted rows reopen their owner; a second adoption would conflict.
  if (session.structuredSession) {
    return { available: false, reason: 'already-structured' }
  }
  const recordingHost = parseRoutableExecutionHostId(session.executionHostId)
  if (
    !recordingHost ||
    (recordingHost.kind !== 'local' && recordingHost.kind !== 'runtime') ||
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
    !aiVaultSessionCwdInWorkspace(session.cwd, args.targetWorkspacePath, session.cwdAliases)
  ) {
    return { available: false, reason: 'workspace' }
  }
  return { available: true, workspaceId: args.targetWorkspaceId }
}
