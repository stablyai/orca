import { useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatComposerNotice } from '../../composer/controls/native-chat-composer-notice'

// The one line a chat's message box shows about notes just added, with its Undo. In the message
// box rather than a corner toast, so it sits beside what it talks about.

/** `onEnd`: runs once when the line goes, whichever way (dismissed, expired or replaced).
 *  `sticky`: the line stays until dismissed or replaced, for news the user must not miss. */
type NotesNotice = { text: string; undo?: () => void; onEnd?: () => void; sticky?: boolean }

/** A notes line goes after this long, and its Undo with it. */
export const NATIVE_CHAT_NOTES_UNDO_MS = 8000

const notices = new Map<string, NotesNotice>()
const listeners = new Map<string, Set<() => void>>()

function notify(scopeKey: string): void {
  for (const listener of listeners.get(scopeKey) ?? []) {
    listener()
  }
}

/** Shows `text` in the chat's message box, replacing any earlier notes line; `undo` adds an Undo. */
export function showNativeChatNotesNotice(scopeKey: string, notice: NotesNotice): () => void {
  const replaced = notices.get(scopeKey)
  notices.set(scopeKey, notice)
  replaced?.onEnd?.()
  notify(scopeKey)
  const dismiss = (): void => dismissNativeChatNotesNotice(scopeKey, notice)
  if (!notice.sticky) {
    setTimeout(dismiss, NATIVE_CHAT_NOTES_UNDO_MS)
  }
  return dismiss
}

/** Removes the line, only while it is still `notice` when given, so a newer line survives. */
export function dismissNativeChatNotesNotice(scopeKey: string, notice?: NotesNotice): void {
  if (notice && notices.get(scopeKey) !== notice) {
    return
  }
  const ending = notices.get(scopeKey)
  if (notices.delete(scopeKey)) {
    ending?.onEnd?.()
    notify(scopeKey)
  }
}

function subscribe(scopeKey: string, listener: () => void): () => void {
  const set = listeners.get(scopeKey) ?? new Set()
  set.add(listener)
  listeners.set(scopeKey, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      listeners.delete(scopeKey)
    }
  }
}

const cached = new Map<NotesNotice, NativeChatComposerNotice>()

/** The chat's notes line as a message-box notice, or null. */
export function useNativeChatNotesNotice(
  scopeKey: string | undefined
): NativeChatComposerNotice | null {
  const t = useTranslate()
  const notice = useSyncExternalStore(
    (listener) => (scopeKey ? subscribe(scopeKey, listener) : () => {}),
    () => (scopeKey ? (notices.get(scopeKey) ?? null) : null)
  )
  if (!notice || !scopeKey) {
    return null
  }
  // One notice object per line, so the message box doesn't re-render it as new.
  let shown = cached.get(notice)
  if (!shown) {
    const { undo } = notice
    shown = {
      key: 'native-chat-notes',
      kind: 'attachment',
      text: notice.text,
      onDismiss: () => dismissNativeChatNotesNotice(scopeKey, notice),
      ...(undo
        ? {
            action: {
              label: t('components.native-chat.notes.undo', 'Undo'),
              onClick: () => {
                // Only the line still showing undoes: an expired or replaced one does nothing.
                if (notices.get(scopeKey) === notice) {
                  dismissNativeChatNotesNotice(scopeKey, notice)
                  undo()
                }
              }
            }
          }
        : {})
    }
    cached.clear()
    cached.set(notice, shown)
  }
  return shown
}

/** Test-only: forget every line. */
export function resetNativeChatNotesNoticesForTests(): void {
  notices.clear()
  listeners.clear()
  cached.clear()
}
