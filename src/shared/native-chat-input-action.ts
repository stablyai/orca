/** Upper bound the host accepts for a chat-input action id on the wire. */
export const NATIVE_CHAT_INPUT_ACTION_ID_MAX_LENGTH = 128

/** The id every write of one composer action carries (body, Enter, clear, image, answer step). */
export type NativeChatInputAction = { actionId: string }

export function createNativeChatInputAction(): NativeChatInputAction {
  // Why not crypto.randomUUID: the phone's runtime does not guarantee it; uniqueness per PTY suffices.
  return {
    actionId: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  }
}

/** A chat write's outcome; `bytesWritten` counts only transport-settled chunks. */
export type NativeChatInputWriteResult = {
  accepted: boolean
  bytesWritten: number
  /** The opaque chat-action refusal (see `RuntimeTerminalSend.refusedReason`). */
  refusedReason?: 'agent-exited'
  deliveryUnknown?: true
}
