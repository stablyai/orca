import {
  currentDraftScope,
  captureLaunchDraftDestination,
  nativeChatLaunchPromptDraftOwner
} from './native-chat-launch-draft-source'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

type Destination = {
  handle: { current: NativeChatComposerHandle | null }
  active: number
  primary: boolean
}
const destinations = new WeakMap<HTMLElement, Destination>()
const descendants = new WeakMap<HTMLElement, Set<Destination>>()
const scopes = new Map<string, Set<Destination>>()
let activation = 0

/** Registration identity survives disabled transitions; toolbar clicks retain the last focused input. */
export function registerNativeChatComposerDestination(
  root: HTMLElement,
  handle: { current: NativeChatComposerHandle | null },
  primary: boolean,
  scopeKey?: string
): () => void {
  const previous = destinations.get(root)
  const entry = {
    handle,
    active: 0,
    primary
  }
  destinations.set(root, entry)
  const destination = scopeKey ? captureLaunchDraftDestination(scopeKey) : undefined
  if (scopeKey) {
    scopeKey = currentDraftScope(scopeKey)
    const members =
      (nativeChatLaunchPromptDraftOwner(scopeKey) && scopes.get(scopeKey)) || new Set<Destination>()
    members.add(entry)
    scopes.set(scopeKey, members)
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
    if (scopeKey) {
      const key = destination?.scopeKey ?? scopeKey
      const members = scopes.get(key)
      members?.delete(entry)
      if (members?.size === 0) {
        scopes.delete(key)
      }
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
  return selectDestination((root ? descendants.get(root) : undefined) ?? []) ?? fallback
}

function selectDestination(entries: Iterable<Destination>): NativeChatComposerHandle | null {
  let selected: Destination | undefined
  let handle: NativeChatComposerHandle | null = null
  for (const entry of entries) {
    const current = entry.handle.current
    if (!current) {
      continue
    }
    if (
      !selected ||
      entry.active > selected.active ||
      (entry.active === selected.active && entry.primary)
    ) {
      selected = entry
      handle = current
    }
  }
  return handle
}

export function nativeChatComposerScopeDestination(
  scopeKey: string
): NativeChatComposerHandle | null {
  return selectDestination(scopes.get(currentDraftScope(scopeKey)) ?? [])
}

export function moveNativeChatComposerDestinations(from: string, to: string): void {
  const target = scopes.get(to) ?? new Set<Destination>()
  for (const entry of scopes.get(from) ?? []) {
    target.add(entry)
  }
  scopes.delete(from)
  scopes.set(to, target)
}
