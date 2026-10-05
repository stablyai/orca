import { useCallback, type Dispatch, type KeyboardEventHandler, type SetStateAction } from 'react'
import {
  recallNext,
  recallPrevious,
  type ComposerAutocomplete,
  type HistoryState,
  type NativeChatPickerItem
} from './native-chat-composer-state'
import { isMacPlatform } from './native-chat-shortcut'
import type { SubmitKeyEvent } from './use-claude-submit-gesture'

export type UseNativeChatComposerKeyDownArgs = {
  autocomplete: ComposerAutocomplete
  activeSuggestion: number
  draft: string
  /** Image chips count as composer content, like typed text. */
  hasAttachments?: boolean
  history: HistoryState
  isComposing: () => boolean
  matchesSubmitKey: (event: SubmitKeyEvent) => boolean
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
  activeSuggestion,
  draft,
  hasAttachments = false,
  history,
  isComposing,
  matchesSubmitKey,
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

      if (autocomplete.mode === 'slash') {
        const items = autocomplete.items
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
        if ((event.key === 'Enter' || event.key === 'Tab') && items.length > 0) {
          event.preventDefault()
          const item = items[activeSuggestion] ?? items[0]
          // A mid-prompt command is part of the sentence being written, so Enter
          // completes the token instead of sending the command on its own.
          if (event.key === 'Enter' && item.kind === 'command' && autocomplete.dispatchable) {
            dispatchPickerCommand(item)
          } else {
            completePickerItem(item)
          }
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
      // Cmd/Ctrl+Enter from an empty composer steers the newest queued draft
      // before any submit. Platform primary modifier only (AGENTS.md): ⌘ on Mac,
      // Ctrl elsewhere.
      if (event.key === 'Enter' && !event.shiftKey) {
        const steerChord = isMacPlatform() ? event.metaKey : event.ctrlKey
        const composerEmpty = draft.trim() === '' && !hasAttachments
        if (steerChord && composerEmpty && steerQueued?.()) {
          event.preventDefault()
          return
        }
      }
      if (matchesSubmitKey(event)) {
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
      completePickerItem,
      dismissPicker,
      dispatchPickerCommand,
      draft,
      hasAttachments,
      history,
      interrupt,
      isComposing,
      matchesSubmitKey,
      send,
      steerQueued,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setHistory
    ]
  )
}
