// Which subagent each chat pane shows in place of its conversation; session-only, never persisted.

import { useCallback, useSyncExternalStore } from 'react'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'

/** The subagent a transcript shows (null: the conversation) and how its pane switches. */
export type NativeChatSubagentView = {
  agentId: string | null
  open: (agentId: string | null) => void
}

const openByPane = new Map<string, string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `paneKey` is the chat's status pane key; null returns the pane to its main agent. */
export function openNativeChatSubagent(paneKey: string, agentId: string | null): void {
  if ((openByPane.get(paneKey) ?? null) === agentId) {
    return
  }
  if (agentId === null) {
    openByPane.delete(paneKey)
  } else {
    openByPane.set(paneKey, agentId)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function useNativeChatOpenSubagent(paneKey: string): string | null {
  const read = useCallback(() => openByPane.get(paneKey) ?? null, [paneKey])
  return useSyncExternalStore(subscribe, read, read)
}

/** Esc outside inputs and menus takes the pane back to its main agent. */
export function closeNativeChatSubagentOnEscape(event: React.KeyboardEvent, paneKey: string): void {
  const target = event.target
  if (
    event.key !== 'Escape' ||
    event.defaultPrevented ||
    !openByPane.has(paneKey) ||
    !(target instanceof Element) ||
    // Portaled menus bubble through React but sit outside this pane's DOM.
    !event.currentTarget.contains(target) ||
    isEditableTarget(target) ||
    target.closest('[role="menu"], [role="dialog"], [role="listbox"]') !== null
  ) {
    return
  }
  event.preventDefault()
  openNativeChatSubagent(paneKey, null)
}
