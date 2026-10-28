import { isAntigravityReferenceSession } from '../../../../shared/antigravity-session-origin'
// Native resume requires provider conversation lookup, unlike terminal resume's PTY-hosting gate.

import { isWslStoredAiVaultSessionFile } from '../../../../shared/ai-vault-resume-target'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { parseRoutableExecutionHostId } from '../../../../shared/execution-host'
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

export type AiVaultResumeInChatEligibility =
  | { available: true; workspaceId: string }
  | { available: false; reason: AiVaultResumeInChatBlockedReason }

/** Codex can resume anywhere; other providers require the original cwd or silently miss/refuse/fork the conversation. */
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

/** Compare with shared runtime rules; POSIX case folding would conflate distinct directories. */
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
  /** Reuse structured route capability/platform/WSL gates to prevent drift; the Chat UI switch does not apply. */
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
    !aiVaultSessionCwdMatchesWorkspace(session.cwd, args.targetWorkspacePath)
  ) {
    return { available: false, reason: 'workspace' }
  }
  return { available: true, workspaceId: args.targetWorkspaceId }
}
