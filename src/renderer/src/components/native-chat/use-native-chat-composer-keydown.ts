import { useCallback, type Dispatch, type KeyboardEventHandler, type SetStateAction } from 'react'
import {
  recallNext,
  recallPrevious,
  type ComposerAutocomplete,
  type HistoryState,
  type NativeChatPickerItem
} from './native-chat-composer-state'
import { isMacPlatform } from './native-chat-shortcut'
import type { NativeChatMentionFiles } from './use-native-chat-mention-files'

export type UseNativeChatComposerKeyDownArgs = {
  autocomplete: ComposerAutocomplete
  mentionFiles: NativeChatMentionFiles
  completeMention: (path: string) => void
  activeSuggestion: number
  draft: string
  /** Image chips count as composer content, like typed text. */
  hasAttachments?: boolean
  history: HistoryState
  isComposing: () => boolean
  completePickerItem: (item: NativeChatPickerItem) => void
  dispatchPickerCommand: (item: Extract<NativeChatPickerItem, { kind: 'command' }>) => void
  dismissPicker: (triggerKey: string) => void
  interrupt: () => void
  send: () => void
  /** Cmd/Ctrl+Enter from an empty composer: send the newest queued draft now; false falls
   *  through to send. */
  steerQueued?: (() => boolean) | undefined
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  setDraft: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setHistory: Dispatch<SetStateAction<HistoryState>>
}

export function useNativeChatComposerKeyDown({
  autocomplete,
  mentionFiles,
  completeMention,
  activeSuggestion,
  draft,
  hasAttachments = false,
  history,
  isComposing,
  completePickerItem,
  dispatchPickerCommand,
  dismissPicker,
  interrupt,
  send,
  steerQueued,
  setActiveSuggestion,
  setDraft,
  setCaret,
  setHistory
}: UseNativeChatComposerKeyDownArgs): KeyboardEventHandler<HTMLElement> {
  return useCallback(
    (event) => {
      if (isComposing() || event.nativeEvent.isComposing || event.keyCode === 229) {
        // Why: IME Enter confirms composition; allowing it to fall through
        // would accept a picker row or submit a partial draft.
        if (event.key === 'Enter') {
          event.preventDefault()
        }
        return
      }
      // An open layer that keeps focus here, like the context card, already spent this Escape closing itself.
      if (event.key === 'Escape' && event.defaultPrevented) {
        return
      }

      if (autocomplete.mode !== 'none') {
        const items = autocomplete.mode === 'slash' ? autocomplete.items : mentionFiles.files
        if (event.key === 'ArrowDown' && items.length > 0) {
          event.preventDefault()
          setActiveSuggestion((index) => (index + 1) % items.length)
          return
        }
        if (event.key === 'ArrowUp' && items.length > 0) {
          event.preventDefault()
          setActiveSuggestion((index) => (index - 1 + items.length) % items.length)
          return
        }
        // Shift keeps its own meaning: a newline for Enter, focus back for Tab.
        const picks = (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey
        if (picks && items.length > 0) {
          event.preventDefault()
          if (autocomplete.mode === 'mention') {
            const { files } = mentionFiles
            completeMention(files[Math.min(activeSuggestion, files.length - 1)])
            return
          }
          const item = autocomplete.items[activeSuggestion] ?? autocomplete.items[0]
          // A mid-prompt command is part of the sentence being written, so Enter
          // completes the token instead of sending the command on its own.
          if (event.key === 'Enter' && item.kind === 'command' && autocomplete.dispatchable) {
            dispatchPickerCommand(item)
          } else {
            completePickerItem(item)
          }
          return
        }
        // Why: the files are still on their way, so Enter here is a pick that came early, not a send.
        if (picks && autocomplete.mode === 'mention' && mentionFiles.loading) {
          event.preventDefault()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          dismissPicker(autocomplete.triggerKey)
          return
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        interrupt()
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        // Platform primary modifier only (AGENTS.md): ⌘ on Mac, Ctrl elsewhere.
        const steerChord = isMacPlatform() ? event.metaKey : event.ctrlKey
        // Only from an empty composer: the chord never sends a card past what the user just wrote.
        const composerEmpty = draft.trim() === '' && !hasAttachments
        if (steerChord && composerEmpty && steerQueued?.()) {
          event.preventDefault()
          return
        }
        event.preventDefault()
        send()
        return
      }
      if (event.key === 'ArrowUp' && (draft === '' || history.index !== null)) {
        const recall = recallPrevious(history)
        if (recall.draft !== null) {
          event.preventDefault()
          setHistory(recall.history)
          setDraft(recall.draft)
          setCaret(recall.draft.length)
        }
        return
      }
      if (event.key === 'ArrowDown' && history.index !== null) {
        const recall = recallNext(history)
        if (recall.draft !== null) {
          event.preventDefault()
          setHistory(recall.history)
          setDraft(recall.draft)
          setCaret(recall.draft.length)
        }
      }
    },
    [
      activeSuggestion,
      autocomplete,
      completeMention,
      completePickerItem,
      dismissPicker,
      dispatchPickerCommand,
      draft,
      hasAttachments,
      history,
      interrupt,
      isComposing,
      mentionFiles,
      send,
      steerQueued,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setHistory
    ]
  )
}
