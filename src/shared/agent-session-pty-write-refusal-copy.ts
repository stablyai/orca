import type { AgentSessionPtyWriteRefusal } from './agent-session-pty-write-admission'

export function structuredChatPtyWriteRefusalCopy(
  refusal: AgentSessionPtyWriteRefusal,
  action: 'terminal-send' | 'worker-start'
): string | null {
  if (refusal.ownerRuntimeKind !== 'native') {
    return null
  }
  return action === 'worker-start'
    ? 'The target terminal is in Structured Chat. Switch it to Terminal, then retry `orca orchestration worker-start`.'
    : 'The target terminal is in Structured Chat. Switch it to Terminal, then retry `orca terminal send`.'
}
