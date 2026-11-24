// Which subagent each chat pane shows in place of its conversation; session-only, never persisted.

import { useCallback, useSyncExternalStore } from 'react'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'

/** The subagent a transcript shows (null: the conversation) and how its pane switches. */
export type NativeChatSubagentView = {
  agentId: string | null
  open: (agentId: string | null) => void
  /** The open view names the subagent that spawned it, which Back and Esc return to. */
  noteParent?: (parentId: string | null) => void
}

/** The open subagent and, once its view has read its spawn chain, its parent (null: the main agent). */
export type NativeChatOpenSubagent = { agentId: string; parentId: string | null }

const openByPane = new Map<string, NativeChatOpenSubagent>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** `paneKey` is the chat's status pane key; null returns the pane to its main agent. */
export function openNativeChatSubagent(paneKey: string, agentId: string | null): void {
  if ((openByPane.get(paneKey)?.agentId ?? null) === agentId) {
    return
  }
  if (agentId === null) {
    openByPane.delete(paneKey)
  } else {
    openByPane.set(paneKey, { agentId, parentId: null })
  }
  publish()
}

/** A closed or replaced chat tab takes its panes' open subagents with it. */
export function retireNativeChatSubagentViews(tabId: string): void {
  let retired = false
  for (const paneKey of openByPane.keys()) {
    if (paneKey.startsWith(`${tabId}:`)) {
      openByPane.delete(paneKey)
      retired = true
    }
  }
  if (retired) {
    publish()
  }
}

export function noteNativeChatSubagentParent(
  paneKey: string,
  agentId: string,
  parentId: string | null
): void {
  const open = openByPane.get(paneKey)
  if (open?.agentId === agentId && open.parentId !== parentId) {
    openByPane.set(paneKey, { agentId, parentId })
    publish()
  }
}

/** Back from a subagent: to the subagent that spawned it, else to the main agent. */
export function backFromNativeChatSubagent(paneKey: string): void {
  openNativeChatSubagent(paneKey, openByPane.get(paneKey)?.parentId ?? null)
}

export function useNativeChatOpenSubagent(paneKey: string): NativeChatOpenSubagent | null {
  const read = useCallback(() => openByPane.get(paneKey) ?? null, [paneKey])
  return useSyncExternalStore(subscribe, read, read)
}

/** Esc outside inputs and menus goes back a level. */
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
  backFromNativeChatSubagent(paneKey)
}
