import type { ExecutionHostId } from '../../execution-host'
import { resolveNativeChatTranscriptAgent } from '../../native-chat/native-chat-agent-support'
import type { AiVaultAgent } from './ai-vault-types'

/** Agents whose rows name one conversation inside an account-wide database. */
export function isAiVaultDatabaseAgent(
  agent: AiVaultAgent
): agent is Extract<AiVaultAgent, 'opencode' | 'opencode2' | 'zcode'> {
  return resolveNativeChatTranscriptAgent(agent) === 'opencode'
}

/** How long a hand-off waits for the host's saved copy before using the preview. */
export const AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS = 30_000

export type AiVaultSessionHandoffArgs = {
  agent: AiVaultAgent
  /** The database path, or `<db>#<session id>`. */
  filePath: string
  sessionId?: string
  executionHostId?: ExecutionHostId
}

/** Absent `transcriptPath`: no saved copy (older host, SSH row, unreadable database); use the preview. */
export type AiVaultSessionHandoffResult = { transcriptPath?: string }

/** Reads a host's answer; anything but a non-empty path keeps the preview hand-off. */
export function readAiVaultSessionHandoffResult(value: unknown): AiVaultSessionHandoffResult {
  const transcriptPath =
    value && typeof value === 'object' && 'transcriptPath' in value ? value.transcriptPath : null
  return typeof transcriptPath === 'string' && transcriptPath ? { transcriptPath } : {}
}
