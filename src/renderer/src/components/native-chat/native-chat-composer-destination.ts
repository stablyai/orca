import type { NativeChatComposerHandle } from './native-chat-composer-types'

type Destination = {
  handle: { current: NativeChatComposerHandle | null }
  active: number
  primary: boolean
}
const destinations = new WeakMap<HTMLElement, Destination>()
const descendants = new WeakMap<HTMLElement, Set<Destination>>()
const scopes = new Map<string, Destination>()
let activation = 0

/** Registration identity survives disabled transitions; toolbar clicks retain the last focused input. */
export function registerNativeChatComposerDestination(
  root: HTMLElement,
  handle: { current: NativeChatComposerHandle | null },
  primary: boolean,
  scopeKey?: string
): () => void {
  const previous = destinations.get(root)
  const entry = { handle, active: 0, primary }
  destinations.set(root, entry)
  if (scopeKey) {
    scopes.set(scopeKey, entry)
  }
  const ancestors: HTMLElement[] = []
  for (let parent: HTMLElement | null = root; parent; parent = parent.parentElement) {
    ancestors.push(parent)
    const entries = descendants.get(parent) ?? new Set<Destination>()
    if (previous) {
      entries.delete(previous)
    }
    entries.add(entry)
    descendants.set(parent, entries)
  }
  const activate = (): void => {
    entry.active = ++activation
  }
  root.addEventListener('focusin', activate)
  root.addEventListener('pointerdown', activate)
  return () => {
    if (scopeKey && scopes.get(scopeKey) === entry) {
      scopes.delete(scopeKey)
    }
    root.removeEventListener('focusin', activate)
    root.removeEventListener('pointerdown', activate)
    for (const parent of ancestors) {
      descendants.get(parent)?.delete(entry)
    }
    if (destinations.get(root) === entry) {
      destinations.delete(root)
    }
  }
}

export function nativeChatComposerDestination(
  root: HTMLElement | null,
  fallback: NativeChatComposerHandle | null
): NativeChatComposerHandle | null {
  let selected: Destination | undefined
  for (const entry of (root ? descendants.get(root) : undefined) ?? []) {
    if (
      !selected ||
      entry.active > selected.active ||
      (entry.active === selected.active && entry.primary)
    ) {
      selected = entry
    }
  }
  return selected?.handle.current ?? fallback
}

export function nativeChatComposerScopeDestination(
  scopeKey: string
): NativeChatComposerHandle | null {
  return scopes.get(scopeKey)?.handle.current ?? null
}
