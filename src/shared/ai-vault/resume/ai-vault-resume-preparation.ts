import type { AiVaultAgent, AiVaultSession } from '../contracts/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../execution-host'

export type AiVaultConversationCopy = {
  sessionId: string
  filePath?: string
}

export type AiVaultPrepareSessionResumeArgs = Pick<
  AiVaultSession,
  'agent' | 'filePath' | 'codexHome' | 'executionHostId'
> &
  Partial<Pick<AiVaultSession, 'sessionId'>> & {
    /** A fork only reads the conversation, so a native chat that owns it does not refuse it.
     *  Older hosts drop the field and refuse as for a resume. */
    fork?: boolean
  }

export const AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY = 'ai-vault.chat-fork-source.v1' as const

export type AiVaultChatForkSource = Pick<
  AiVaultSession,
  'agent' | 'sessionId' | 'filePath' | 'cwd' | 'codexHome'
> & { executionHostPlatform: NodeJS.Platform; sourceAgent: AiVaultAgent }

export type AiVaultPrepareChatForkArgs = {
  sourceChat: { sessionId: string; workspaceId: string }
  executionHostId?: string
  fork: true
}

export type AiVaultPrepareSessionResumeRequest =
  | AiVaultPrepareSessionResumeArgs
  | AiVaultPrepareChatForkArgs

export type AiVaultPrepareSessionResumeResult = {
  useRealCodexHome: boolean
  cliForkSource?: AiVaultChatForkSource
  // Cross-account hardlinks share rollouts: the host repins to the selected home. Absent/older-host replies retain the session's home.
  substituteCodexHome?: string
  /** Chat-made fork identity and actual launch agent (opencode2 chats run opencode); older hosts omit it and make no copy. */
  forkedSession?: AiVaultConversationCopy & { agent: AiVaultAgent }
}

export type AiVaultSessionResumePreparation = (
  args: AiVaultPrepareSessionResumeArgs
) => Promise<AiVaultPrepareSessionResumeResult>

const LEGACY_MOBILE_PREPARATION_FORBIDDEN_MESSAGE =
  "Method 'aiVault.prepareSessionResume' is not available to mobile clients"

export function isAiVaultPrepareSessionResumeUnavailableError(error: {
  code: string
  message: string
}): boolean {
  return (
    error.code === 'method_not_found' ||
    (error.code === 'forbidden' && error.message === LEGACY_MOBILE_PREPARATION_FORBIDDEN_MESSAGE)
  )
}

export function isLegacySharedCodexHome(codexHome: string | null): boolean {
  if (!codexHome) {
    return false
  }
  const segments = codexHome.split(/[\\/]/).filter(Boolean)
  return segments.at(-2) === 'codex-runtime-home' && segments.at(-1) === 'home'
}

/** Matches the managed `codex-accounts/<id>/home` layout, mirroring the AI Vault scan-root shape check. */
export function isPerAccountManagedCodexHome(codexHome: string | null): boolean {
  if (!codexHome) {
    return false
  }
  const segments = codexHome.split(/[\\/]/).filter(Boolean)
  return segments.at(-3) === 'codex-accounts' && segments.at(-1) === 'home'
}

export function aiVaultSessionNeedsResumePreparation(
  session: Pick<AiVaultSession, 'agent' | 'codexHome' | 'executionHostId'>
): boolean {
  if (session.agent !== 'codex') {
    return false
  }
  if (isLegacySharedCodexHome(session.codexHome)) {
    return true
  }
  // Only local sessions may repin from this client’s account selection; remote sessions retain their recorded home.
  return (
    isPerAccountManagedCodexHome(session.codexHome) &&
    (!session.executionHostId || session.executionHostId === LOCAL_EXECUTION_HOST_ID)
  )
}

/** What a terminal resume asks the host to prepare: a Codex home only where the session needs one
 *  readied; the host checks who owns the session either way. Desktop and plugin resumes share it. */
export function aiVaultTerminalResumeRequest(
  args: AiVaultPrepareSessionResumeArgs
): AiVaultPrepareSessionResumeArgs {
  return aiVaultSessionNeedsResumePreparation(args) ? args : { ...args, codexHome: null }
}

/** The host's answer as a terminal resume applies it; a malformed one refuses the resume. */
export function aiVaultTerminalResumeResult(
  args: AiVaultPrepareSessionResumeArgs,
  result: AiVaultPrepareSessionResumeResult | null | undefined
): AiVaultPrepareSessionResumeResult {
  if (
    typeof result?.useRealCodexHome !== 'boolean' ||
    (result.substituteCodexHome !== undefined && typeof result.substituteCodexHome !== 'string')
  ) {
    throw new Error('Invalid aiVault.prepareSessionResume response')
  }
  // Why: old desktop resumes kept the recorded home for sessions that need no readying.
  return aiVaultSessionNeedsResumePreparation(args) ? result : { useRealCodexHome: false }
}

/** The Codex home a prepared session resumes in: null for the system home (`useRealCodexHome`),
 *  the selected account's when the host repinned it, else the recorded one. */
export function aiVaultSessionAfterResumePreparation<S extends Pick<AiVaultSession, 'codexHome'>>(
  session: S,
  result: AiVaultPrepareSessionResumeResult
): S {
  if (result.useRealCodexHome) {
    return { ...session, codexHome: null }
  }
  if (result.substituteCodexHome) {
    return { ...session, codexHome: result.substituteCodexHome }
  }
  return session
}
