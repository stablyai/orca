/** Whether Claude chats join Claude Code's Remote Control when they start. `claude-code` follows
 *  Claude Code's own "Enable Remote Control for all sessions"; each chat can still override it. */
export const NATIVE_CHAT_CLAUDE_REMOTE_CONTROL_VALUES = ['claude-code', 'on', 'off'] as const

export type NativeChatClaudeRemoteControl =
  (typeof NATIVE_CHAT_CLAUDE_REMOTE_CONTROL_VALUES)[number]

export function nativeChatClaudeRemoteControl(value: unknown): NativeChatClaudeRemoteControl {
  return value === 'on' || value === 'off' ? value : 'claude-code'
}
