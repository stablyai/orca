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
export const SSH_NATIVE_CHAT_GENERATION_MAX_LENGTH = 128

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
  /** Opaque file-identity stamp from the caller's last read, echoed back so a
   *  transcript replaced by one of the SAME length is still detected. Without
   *  it the cursor is size-only, and the relay falls back to that older
   *  behavior for a host that does not send it. */
  generation?: string
}

export type SshNativeChatRelayReadResult =
  /** The file is exactly where the caller left it; answered from a stat. */
  | { unchanged: true; fileSize: number; generation?: string }
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
      generation?: string
    }
  /** A full window: the first read of a session, a pagination read, or a file
   *  that was replaced under the cursor (rotation, truncation, same-length
   *  rewrite). */
  | {
      messages: NativeChatMessage[]
      hasMore: boolean
      beforeOffset: number
      lifecycle?: NativeChatTurnLifecycle
      fileSize: number
      filePath?: string
      generation?: string
    }
  // `notFound` marks a retry-worthy miss (the agent has not flushed its first
  // JSONL line yet). Any other error is a real failure the caller must surface
  // rather than wait out.
  | { error: string; notFound?: true }

export function isSshNativeChatUnchangedResult(
  result: SshNativeChatRelayReadResult
): result is { unchanged: true; fileSize: number; generation?: string } {
  return 'unchanged' in result
}

export function isSshNativeChatAppendResult(result: SshNativeChatRelayReadResult): result is {
  appended: NativeChatMessage[]
  fileSize: number
  lifecycle?: NativeChatTurnLifecycle
  filePath?: string
  generation?: string
} {
  return 'appended' in result
}

/** The file-identity half of a generation stamp (`dev:ino`), with the mtime
 *  dropped: two stamps sharing it describe the same file, appended to or not. */
export function sshNativeChatFileIdentity(generation: string | undefined): string | undefined {
  if (!generation) {
    return undefined
  }
  const parts = generation.split(':')
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : undefined
}
