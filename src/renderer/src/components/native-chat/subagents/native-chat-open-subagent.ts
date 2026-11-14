// Which subagent each chat pane shows in its sheet; session-only, never persisted.

import { useCallback, useSyncExternalStore } from 'react'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'

/** Marks the pane's subagent sheet, the one dialog whose Esc goes back a level. */
export const NATIVE_CHAT_SUBAGENT_SHEET_ATTRIBUTE = 'data-native-chat-subagent-sheet'
/** The sheet's Close, which takes focus a vanished Stop dropped. */
export const NATIVE_CHAT_SUBAGENT_SHEET_CLOSE_ATTRIBUTE = 'data-native-chat-subagent-sheet-close'

/** The subagent a transcript shows (null: the conversation) and how its pane switches. */
export type NativeChatSubagentView = {
  agentId: string | null
  open: (agentId: string | null) => void
  /** The open view names the subagent that spawned it, which the header and Esc return to. */
  noteParent?: (parentId: string | null) => void
  /** Present on the sheet's view: what its header offers beyond the switcher. */
  sheet?: NativeChatSubagentSheetControls
}

export type NativeChatSubagentSheetControls = {
  titleId: string
  /** The subagent's Stop, which shows while it can be stopped. */
  stop?: React.ReactNode
  /** Which agent waits on the person: undefined none, null the main agent. */
  waiting?: string | null
  /** Closes the sheet, or swaps it, to where the waiting prompt shows. */
  showWaiting: (agentId: string | null) => void
}

/** The open subagent and, once its view has read its spawn chain, its parent (null: the main agent). */
export type NativeChatOpenSubagent = { agentId: string; parentId: string | null }

const openByPane = new Map<string, NativeChatOpenSubagent>()
// What had focus when the sheet opened, to hand it back on close; 'prompt': the pane's waiting prompt.
const openerByPane = new Map<string, Element | 'prompt'>()
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
    if (!openByPane.has(paneKey) && document.activeElement) {
      openerByPane.set(paneKey, document.activeElement)
    }
    openByPane.set(paneKey, { agentId, parentId: null })
  }
  publish()
}

/** Closes the pane's sheet to show the main agent's waiting prompt, which takes focus. */
export function closeNativeChatSubagentToPrompt(paneKey: string): void {
  if (openByPane.has(paneKey)) {
    openerByPane.set(paneKey, 'prompt')
  }
  openNativeChatSubagent(paneKey, null)
}

/** Where the pane's sheet hands focus back on close, once: what opened it, or its waiting prompt. */
export function takeNativeChatSubagentOpener(paneKey: string): Element | 'prompt' | undefined {
  const opener = openerByPane.get(paneKey)
  openerByPane.delete(paneKey)
  return opener
}

/** A closed or replaced chat tab takes its panes' open subagents with it. */
export function retireNativeChatSubagentViews(tabId: string): void {
  let retired = false
  for (const paneKey of openByPane.keys()) {
    if (paneKey.startsWith(`${tabId}:`)) {
      openByPane.delete(paneKey)
      openerByPane.delete(paneKey)
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

/** Esc outside inputs, menus and other dialogs goes back a level. */
export function closeNativeChatSubagentOnEscape(
  event: Pick<
    React.KeyboardEvent,
    'key' | 'defaultPrevented' | 'target' | 'currentTarget' | 'preventDefault'
  >,
  paneKey: string
): void {
  const target = event.target
  if (
    event.key !== 'Escape' ||
    event.defaultPrevented ||
    !openByPane.has(paneKey) ||
    !(target instanceof Element) ||
    // Portaled menus bubble through React but sit outside this pane's DOM.
    !event.currentTarget.contains(target) ||
    isEditableTarget(target) ||
    target.closest(
      `[role="menu"], [role="listbox"], [role="dialog"]:not([${NATIVE_CHAT_SUBAGENT_SHEET_ATTRIBUTE}])`
    ) !== null
  ) {
    return
  }
  event.preventDefault()
  backFromNativeChatSubagent(paneKey)
}
