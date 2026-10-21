import type { AiVaultAgent, AiVaultSession } from './ai-vault-types'

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
  // Why: cross-account hardlinking lists one rollout under several per-account
  // homes, so the owning host repins resume to the selected account's home.
  // Absent (older hosts included) means resume keeps the session's own home.
  substituteCodexHome?: string
  /** The copy a fork made of a chat's conversation, for an agent whose chat makes it
   *  (`agentForksThroughChat`): its id, and the agent whose CLI opens it, the chat's (an OpenCode
   *  2.x chat lists as `opencode2` but runs `opencode`). Absent from older hosts, which make none. */
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
