import { useCallback, type Dispatch, type KeyboardEventHandler, type SetStateAction } from 'react'
import {
  recallNext,
  recallPrevious,
  type ComposerAutocomplete,
  type HistoryState,
  type NativeChatPickerItem
} from './native-chat-composer-state'

export type UseNativeChatComposerKeyDownArgs = {
  autocomplete: ComposerAutocomplete
  activeSuggestion: number
  draft: string
  history: HistoryState
  isComposing: () => boolean
  completePickerItem: (item: NativeChatPickerItem) => void
  dispatchPickerCommand: (item: Extract<NativeChatPickerItem, { kind: 'command' }>) => void
  dismissPicker: (triggerKey: string) => void
  interrupt: () => void
  send: () => void
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  setDraft: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setHistory: Dispatch<SetStateAction<HistoryState>>
}

export function useNativeChatComposerKeyDown({
  autocomplete,
  activeSuggestion,
  draft,
  history,
  isComposing,
  completePickerItem,
  dispatchPickerCommand,
  dismissPicker,
  interrupt,
  send,
  setActiveSuggestion,
  setDraft,
  setCaret,
  setHistory
}: UseNativeChatComposerKeyDownArgs): KeyboardEventHandler<HTMLTextAreaElement> {
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

      if (autocomplete.mode === 'slash' || autocomplete.mode === 'skill') {
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
          if (event.key === 'Enter' && item.kind === 'command') {
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
      if (event.key === 'Enter' && !event.shiftKey) {
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
      history,
      interrupt,
      isComposing,
      send,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setHistory
    ]
  )
}
