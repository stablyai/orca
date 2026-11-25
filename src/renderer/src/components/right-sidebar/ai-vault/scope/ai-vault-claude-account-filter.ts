import { useSyncExternalStore } from 'react'
import type { AiVaultClaudeAccountFilter } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-claude-account'

// Why module state: the view menu sets it and the panel reads it, without threading it through
// every layer between them. It is a view choice for this window only, never saved.
let current: AiVaultClaudeAccountFilter
const listeners = new Set<() => void>()

export function setAiVaultClaudeAccountFilter(next: AiVaultClaudeAccountFilter): void {
  if (next === current) {
    return
  }
  current = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAiVaultClaudeAccountFilter(): AiVaultClaudeAccountFilter {
  return useSyncExternalStore(subscribe, () => current)
}
