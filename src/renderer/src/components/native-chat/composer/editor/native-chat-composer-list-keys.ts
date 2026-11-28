import type { KeyboardEvent } from 'react'
import { isMacPlatform } from '../../pane/routing/native-chat-shortcut'
import {
  continueListAtEnter,
  shiftListIndent,
  toggleInlineMark,
  type NativeChatTextChange
} from './native-chat-markdown-list-lines'
import type { NativeChatComposerInput } from './native-chat-composer-input'

function changeFor(
  event: KeyboardEvent<HTMLElement>,
  text: string,
  from: number,
  to: number
): NativeChatTextChange | null {
  const mod = isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  const key = event.key.toLowerCase()
  if (mod && !event.altKey && !event.shiftKey && (key === 'i' || (key === 'b' && from !== to))) {
    return toggleInlineMark(text, from, to, key === 'b' ? '**' : '*')
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null
  }
  if (event.key === 'Tab') {
    return shiftListIndent(text, from, to, event.shiftKey)
  }
  return event.key === 'Enter' && !event.shiftKey && from === to
    ? continueListAtEnter(text, from)
    : null
}

/** List Enter/Tab and bold/italic chords as plain-text edits; false leaves the key to send or default. */
export function handleNativeChatListKey(
  event: KeyboardEvent<HTMLElement>,
  input: NativeChatComposerInput | null
): boolean {
  const { selectionStart: from, selectionEnd: to } = input ?? {}
  if (!input?.applyTextChange || from == null || to == null) {
    return false
  }
  const change = changeFor(event, input.value, from, to)
  if (!change) {
    return false
  }
  event.preventDefault()
  input.applyTextChange(change)
  return true
}
