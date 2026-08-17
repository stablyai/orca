import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { applyMentionSuggestion, type HistoryState } from './native-chat-composer-state'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import type { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'

export function useNativeChatComposerInputActions(args: {
  picker: NativeChatPickerState
  dispatchPtyPickerCommand: ReturnType<typeof useNativeChatPickerCommandDispatch>
  structuredTransport: boolean
  sendStructured: (text: string) => void
  activeSuggestion: number
  draft: string
  caret: number
  history: HistoryState
  isComposing: () => boolean
  interrupt: () => void
  send: () => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  syncCaret: (element: HTMLTextAreaElement) => void
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  setDraft: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setHistory: Dispatch<SetStateAction<HistoryState>>
}) {
  const {
    picker,
    dispatchPtyPickerCommand,
    structuredTransport,
    sendStructured,
    activeSuggestion,
    draft,
    caret,
    history,
    isComposing,
    interrupt,
    send,
    textareaRef,
    syncCaret,
    setActiveSuggestion,
    setDraft,
    setCaret,
    setHistory
  } = args
  const dispatchPickerCommand = useCallback(
    (command: Parameters<typeof dispatchPtyPickerCommand>[0]) => {
      if (structuredTransport) {
        sendStructured(`/${command.name}`)
        return
      }
      dispatchPtyPickerCommand(command)
    },
    [dispatchPtyPickerCommand, sendStructured, structuredTransport]
  )
  const handleKeyDown = useNativeChatComposerKeyDown({
    autocomplete: picker.autocomplete,
    activeSuggestion,
    draft,
    history,
    isComposing,
    completePickerItem: picker.completeItem,
    dispatchPickerCommand,
    dismissPicker: picker.dismiss,
    interrupt,
    send,
    setActiveSuggestion,
    setDraft,
    setCaret,
    setHistory
  })
  const handleDraftChange = useCallback(
    (value: string, element: HTMLTextAreaElement) => {
      setDraft(value)
      setHistory((previous) => ({ entries: previous.entries, index: null }))
      syncCaret(element)
      picker.handleDraftOrCaretChange(value, element.selectionStart ?? value.length)
      setActiveSuggestion(0)
    },
    [picker, setActiveSuggestion, setDraft, setHistory, syncCaret]
  )
  const handleTextareaSelect = useCallback(
    (element: HTMLTextAreaElement) => {
      syncCaret(element)
      picker.handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
      setActiveSuggestion(0)
    },
    [picker, setActiveSuggestion, syncCaret]
  )
  const acceptMention = useCallback(() => {
    if (picker.autocomplete.mode !== 'mention') {
      return
    }
    const result = applyMentionSuggestion(draft, caret, picker.autocomplete.query)
    setDraft(result.draft)
    setCaret(result.caret)
    const textarea = textareaRef.current
    textarea?.focus()
    requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
  }, [caret, draft, picker.autocomplete, setCaret, setDraft, textareaRef])

  return { handleKeyDown, handleDraftChange, handleTextareaSelect, acceptMention }
}
