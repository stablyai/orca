import type { RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { TerminalRichInputQuery } from './terminal-rich-input-autocomplete'

type TerminalRichInputKeydownContext = {
  mentionRef: RefObject<TerminalRichInputQuery | null>
  slashRef: RefObject<TerminalRichInputQuery | null>
  fileSuggestionsRef: RefObject<string[]>
  slashSuggestionsRef: RefObject<SlashCommandSuggestion[]>
  activeSuggestionRef: RefObject<number>
  setActiveSuggestion: (update: (index: number) => number) => void
  pasteImageFromClipboard: () => void
  insertHardBreak: () => boolean
  chooseFile: (path: string) => void
  chooseSlash: (command: SlashCommandSuggestion, submit: boolean) => void
  closeAutocomplete: () => void
  closeComposer: () => void
  submit: () => void
}

export function insertTerminalRichInputHardBreak(editor: Editor): boolean {
  if (!editor.commands.setHardBreak()) {
    return false
  }
  const { doc, selection } = editor.state
  if (selection.empty && selection.to >= doc.content.size - 1) {
    editor.view.dom.scrollTop = editor.view.dom.scrollHeight
  } else {
    editor.commands.scrollIntoView()
  }
  return true
}

export function handleTerminalRichInputKeyDown(
  event: KeyboardEvent,
  context: TerminalRichInputKeydownContext
): boolean {
  if (event.isComposing || event.keyCode === 229) {
    return false
  }
  const pasteModifier = getShortcutPlatform() === 'darwin' ? event.metaKey : event.ctrlKey
  if (event.key.toLowerCase() === 'v' && pasteModifier && !event.shiftKey && !event.repeat) {
    // Native Electron image clipboards can omit the DOM paste payload. Probe
    // first, but the attachment hook does not block text paste unless an image exists.
    context.pasteImageFromClipboard()
  }
  const currentMention = context.mentionRef.current
  const fileSuggestions = context.fileSuggestionsRef.current
  const currentSlash = context.slashRef.current
  const slashSuggestions = context.slashSuggestionsRef.current
  const suggestionCount = currentMention
    ? fileSuggestions.length
    : currentSlash
      ? slashSuggestions.length
      : 0
  if (suggestionCount > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    context.setActiveSuggestion((index) => (index + direction + suggestionCount) % suggestionCount)
    return true
  }
  if (currentMention && fileSuggestions.length > 0) {
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      context.chooseFile(fileSuggestions[context.activeSuggestionRef.current] ?? fileSuggestions[0])
      return true
    }
  }
  if (currentSlash && slashSuggestions.length > 0) {
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      context.chooseSlash(
        slashSuggestions[context.activeSuggestionRef.current] ?? slashSuggestions[0],
        event.key === 'Enter'
      )
      return true
    }
  }
  if (event.key === 'Enter' && event.shiftKey) {
    const handled = context.insertHardBreak()
    if (handled) {
      event.preventDefault()
    }
    return handled
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (currentMention || (currentSlash && slashSuggestions.length > 0)) {
      context.closeAutocomplete()
    } else {
      context.closeComposer()
    }
    return true
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    context.submit()
    return true
  }
  return false
}
