import { useCallback, useSyncExternalStore } from 'react'

// Why: keyed by the draft owner so every composer showing a conversation agrees, and kept in
// memory so a tab switch or a retained pane keeps it without persisting a view preference.
const collapsedScopes = new Set<string>()
const scopeListeners = new Map<string, Set<() => void>>()

export function isNativeChatComposerCollapsed(scopeKey: string): boolean {
  return collapsedScopes.has(scopeKey)
}

export function setNativeChatComposerCollapsed(scopeKey: string, collapsed: boolean): void {
  if (collapsedScopes.has(scopeKey) === collapsed) {
    return
  }
  if (collapsed) {
    collapsedScopes.add(scopeKey)
  } else {
    collapsedScopes.delete(scopeKey)
  }
  for (const listener of scopeListeners.get(scopeKey) ?? []) {
    listener()
  }
}

function subscribeToNativeChatComposerCollapse(scopeKey: string, listener: () => void): () => void {
  const listeners = scopeListeners.get(scopeKey) ?? new Set()
  scopeListeners.set(scopeKey, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && scopeListeners.get(scopeKey) === listeners) {
      scopeListeners.delete(scopeKey)
    }
  }
}

/** Whether this conversation's message box is collapsed to one line, and a setter for it. */
export function useNativeChatComposerCollapsed(
  scopeKey: string
): [collapsed: boolean, setCollapsed: (collapsed: boolean) => void] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerCollapse(scopeKey, listener),
    [scopeKey]
  )
  const collapsed = useSyncExternalStore(subscribe, () => isNativeChatComposerCollapsed(scopeKey))
  const setCollapsed = useCallback(
    (next: boolean) => setNativeChatComposerCollapsed(scopeKey, next),
    [scopeKey]
  )
  return [collapsed, setCollapsed]
}
