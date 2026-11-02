import { useLayoutEffect } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'

type MountedComposer = {
  input: NativeChatComposerInput
  isComposing: () => boolean
}
const inputs = new Map<string, Set<MountedComposer>>()
const panes = new Map<string, Set<() => boolean>>()
const listeners = new Set<() => void>()

export function notifyNativeChatComposerState(): void {
  // React may replace an owner in one commit; observe the settled registry and IME value.
  queueMicrotask(() => {
    for (const listener of listeners) {
      listener()
    }
  })
}

export function registerNativeChatPane(tabId: string, isActionable: () => boolean): () => void {
  const owners = panes.get(tabId) ?? new Set()
  panes.set(tabId, owners)
  owners.add(isActionable)
  notifyNativeChatComposerState()
  return () => {
    owners.delete(isActionable)
    if (owners.size === 0) {
      panes.delete(tabId)
    }
    notifyNativeChatComposerState()
  }
}

export function useNativeChatComposerMount(
  scopeKey: string,
  input: NativeChatComposerInput | null,
  isComposing: () => boolean,
  disabled: boolean
): void {
  useLayoutEffect(() => {
    if (!input) {
      return
    }
    const owners = inputs.get(scopeKey) ?? new Set()
    inputs.set(scopeKey, owners)
    const owner = { input, isComposing }
    owners.add(owner)
    notifyNativeChatComposerState()
    return () => {
      owners.delete(owner)
      if (owners.size === 0) {
        inputs.delete(scopeKey)
      }
      notifyNativeChatComposerState()
    }
  }, [disabled, input, isComposing, scopeKey])
}

export function nativeChatComposerSelection(
  scopeKey: string
): { from: number; to: number } | undefined {
  for (const { input } of inputs.get(scopeKey) ?? []) {
    if (input.contains?.(document.activeElement)) {
      return { from: input.selectionStart, to: input.selectionEnd }
    }
  }
  return undefined
}

/** Publication precedes React mounting, especially when the workbench is still loading. */
export function waitForNativeChatComposerHandoff(
  sourceScope: string,
  destinationTabId: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      listeners.delete(check)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const check = (): void => {
      const ready = [...(panes.get(destinationTabId) ?? [])].some((isActionable) => isActionable())
      const composing = [...(inputs.get(sourceScope) ?? [])].some((owner) => owner.isComposing())
      if ((ready && !composing) || signal.aborted) {
        finish()
      }
    }
    listeners.add(check)
    signal.addEventListener('abort', finish, { once: true })
    check()
  })
}
