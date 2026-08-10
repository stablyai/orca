import type { NativeChatMessage, NativeChatTurnLifecycle } from './native-chat-types'

/** Relay-side native chat transcript read. The desktop main process cannot open
 *  an SSH worktree's transcript — the agent writes it on the remote host — so the
 *  read, resolve and decode all run next to the file and only the rendered window
 *  crosses the mux. Mirrors the AI Vault relay methods in `ssh-ai-vault-relay.ts`. */
export const SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD = 'nativeChat.readTranscript' as const
export const SSH_NATIVE_CHAT_READ_TRANSCRIPT_TIMEOUT_MS = 20_000
/** Matches the runtime RPC's own maximum window so a paired client cannot ask a
 *  relay for more history than the host would ever forward. */
export const SSH_NATIVE_CHAT_READ_LIMIT_MAX = 2000
export const SSH_NATIVE_CHAT_TRANSCRIPT_PATH_MAX_LENGTH = 4096

export type SshNativeChatRelayReadParams = {
  agent: string
  sessionId: string
  limit: number
  /** Authoritative remote transcript path reported by the agent hook. */
  transcriptPath?: string
  beforeOffset?: number
  /** Byte cursor the caller has already consumed. Drives the three live-tail
   *  answers below: unchanged, appended, or a full window when the file was
   *  replaced under the cursor. Omit it to force a full window. */
  knownFileSize?: number
}

export type SshNativeChatRelayReadResult =
  /** The file is exactly where the caller left it; answered from a stat. */
  | { unchanged: true; fileSize: number }
  /** Records written past the caller's cursor. `fileSize` is the new cursor,
   *  which stops at the last complete line so a half-written record is re-read
   *  next tick instead of decoded as garbage. */
  | {
      appended: NativeChatMessage[]
      fileSize: number
      lifecycle?: NativeChatTurnLifecycle
      /** Path the relay resolved, echoed back so the next poll names the file
       *  instead of walking the remote agent home again. */
      filePath?: string
    }
  /** A full window: the first read of a session, a pagination read, or a file
   *  that shrank under the cursor (rotation or truncation). */
  | {
      messages: NativeChatMessage[]
      hasMore: boolean
      beforeOffset: number
      lifecycle?: NativeChatTurnLifecycle
      fileSize: number
      filePath?: string
    }
  // `notFound` marks a retry-worthy miss (the agent has not flushed its first
  // JSONL line yet) rather than an error the chat view should settle on.
  | { error: string; notFound?: true }

export function isSshNativeChatUnchangedResult(
  result: SshNativeChatRelayReadResult
): result is { unchanged: true; fileSize: number } {
  return 'unchanged' in result
}

export function isSshNativeChatAppendResult(
  result: SshNativeChatRelayReadResult
): result is { appended: NativeChatMessage[]; fileSize: number; lifecycle?: NativeChatTurnLifecycle } {
  return 'appended' in result
}
