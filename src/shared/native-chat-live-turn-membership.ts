import type { NativeChatRole } from './native-chat-types'
import type { AgentJournalTurnScope } from './agent-session-journal-types'

export function unresolvedNativeChatRowIds(
  messages: readonly { id: string }[],
  scopes: ReadonlyMap<string, AgentJournalTurnScope | undefined>
): ReadonlySet<string> {
  return new Set(
    messages
      .filter((message) => scopes.get(message.id)?.kind === 'unknown')
      .map((message) => message.id)
  )
}

// Use the owning turn’s liveness: its rows remain live while a newer prompt waits behind it.
export function isNativeChatRowInLiveWorkingTurn(
  turnKey: string | undefined,
  liveTurnKey: string | undefined,
  working: boolean,
  membershipUnresolved = false
): boolean {
  return (
    !membershipUnresolved &&
    working &&
    (liveTurnKey ? turnKey === liveTurnKey : turnKey === undefined)
  )
}

export function newestNativeChatUserTurnKey(
  messages: readonly { role: NativeChatRole; unsent?: boolean }[],
  turnKeys: readonly (string | undefined)[]
): string | undefined {
  const index = messages.findLastIndex(
    (message) => message.role === 'user' && message.unsent !== true
  )
  return index === -1 ? undefined : turnKeys[index]
}
