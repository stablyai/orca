import type { NativeChatProviderContinuation } from './native-chat-provider-continuation'

const STORAGE_KEY = 'orca.native-chat-provider-continuations.v1'
const MAX_STORED_CHARS = 2_000_000

export function loadNativeChatProviderContinuations(): Map<string, NativeChatProviderContinuation> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(stored)) {
      return new Map()
    }
    return new Map(
      stored.filter((entry): entry is [string, NativeChatProviderContinuation] => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
          return false
        }
        const value = entry[1]
        return (
          value &&
          ['claude', 'codex', 'grok', 'cursor'].includes(value.agent) &&
          typeof value.sourcePtyId === 'string' &&
          (value.targetPtyId === null || typeof value.targetPtyId === 'string') &&
          (value.context === null || typeof value.context === 'string') &&
          (!value.firstSend ||
            (typeof value.firstSend.wireText === 'string' &&
              typeof value.firstSend.visibleText === 'string')) &&
          Array.isArray(value.messages) &&
          value.messages.every(
            (message: unknown) =>
              typeof message === 'object' &&
              message !== null &&
              'id' in message &&
              typeof message.id === 'string' &&
              'role' in message &&
              typeof message.role === 'string' &&
              'blocks' in message &&
              Array.isArray(message.blocks) &&
              message.blocks.every(
                (block: unknown) => typeof block === 'object' && block !== null && 'type' in block
              )
          )
        )
      })
    )
  } catch {
    return new Map()
  }
}

export function persistNativeChatProviderContinuations(
  records: Map<string, NativeChatProviderContinuation>
): void {
  let serialized = JSON.stringify([...records])
  while (serialized.length > MAX_STORED_CHARS && records.size > 1) {
    records.delete(records.keys().next().value!)
    serialized = JSON.stringify([...records])
  }
  if (serialized.length > MAX_STORED_CHARS) {
    throw new Error('This conversation is too large to retain while switching providers.')
  }
  // Persist before stopping the source provider or dispatching its first continuation.
  localStorage.setItem(STORAGE_KEY, serialized)
}
