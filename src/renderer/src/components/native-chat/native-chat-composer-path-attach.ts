import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'

type NativeChatPathAttacher = {
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  disabled: boolean
}

const attachers = new Map<string, NativeChatPathAttacher>()
let lastFocusedScopeKey: string | null = null

export function registerNativeChatComposerPathAttach(
  scopeKey: string,
  attacher: NativeChatPathAttacher
): () => void {
  attachers.set(scopeKey, attacher)
  return () => {
    if (attachers.get(scopeKey) !== attacher) {
      return
    }
    attachers.delete(scopeKey)
    // Drop the mark only when this scope is gone. Replacing the attacher object
    // for a live pane must not look like an unmount.
    if (lastFocusedScopeKey === scopeKey) {
      lastFocusedScopeKey = null
    }
  }
}

export function markNativeChatComposerPathAttachFocused(scopeKey: string): void {
  if (attachers.has(scopeKey)) {
    lastFocusedScopeKey = scopeKey
  }
}

export function attachResolvedPathsToActiveNativeChatComposer(
  paths: string[],
  connectionId?: string | null
): boolean {
  if (paths.length === 0) {
    return false
  }
  const attacher = resolveActiveNativeChatPathAttacher()
  if (!attacher) {
    return false
  }
  attacher.attachResolvedPaths(paths, connectionId)
  return true
}

function resolveActiveNativeChatPathAttacher(): NativeChatPathAttacher | null {
  const focused = lastFocusedScopeKey ? attachers.get(lastFocusedScopeKey) : undefined
  if (focused && !focused.disabled) {
    return focused
  }
  const ready = [...attachers.values()].filter((attacher) => !attacher.disabled)
  return ready.length === 1 ? (ready[0] ?? null) : null
}

export function resetNativeChatComposerPathAttachForTests(): void {
  attachers.clear()
  lastFocusedScopeKey = null
}
