import {
  useCallback,
  useRef,
  type Dispatch,
  type KeyboardEventHandler,
  type SetStateAction
} from 'react'
import type { ComposerAutocomplete, NativeChatPickerItem } from './native-chat-composer-state'
import { isMacPlatform } from './native-chat-shortcut'
import type { NativeChatMentionFiles } from './use-native-chat-mention-files'
import {
  isNativeChatRecallActive,
  nativeChatSentPrompts,
  stepNativeChatPromptRecall,
  type NativeChatComposerRecall
} from './native-chat-sent-prompt-history'

export type UseNativeChatComposerKeyDownArgs = {
  autocomplete: ComposerAutocomplete
  mentionFiles: NativeChatMentionFiles
  completeMention: (path: string) => void
  activeSuggestion: number
  draft: string
  /** Image chips count as composer content, like typed text. */
  hasAttachments?: boolean
  recall?: NativeChatComposerRecall | undefined
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
}

export function useNativeChatComposerKeyDown({
  autocomplete,
  mentionFiles,
  completeMention,
  activeSuggestion,
  draft,
  hasAttachments = false,
  recall,
  isComposing,
  completePickerItem,
  dispatchPickerCommand,
  dismissPicker,
  interrupt,
  send,
  steerQueued,
  setActiveSuggestion,
  setDraft,
  setCaret
}: UseNativeChatComposerKeyDownArgs): KeyboardEventHandler<HTMLElement> {
  // Read through a ref: the transcript changes on every streamed frame.
  const recallRef = useRef(recall)
  recallRef.current = recall
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
      const arrow = event.key === 'ArrowUp' || event.key === 'ArrowDown'
      // A modified arrow selects or jumps; attachments make the composer non-empty.
      const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
      const recall = recallRef.current
      if (!arrow || !plain || hasAttachments || !recall) {
        return
      }
      const recalling = isNativeChatRecallActive(recall.position, draft)
      // Checked before the layout read and the prompt scan: a typed draft never recalls.
      if (!recalling && (event.key === 'ArrowDown' || draft !== '')) {
        return
      }
      if (!recall.isCaretOnVisualEdge(event.key === 'ArrowUp' ? 'start' : 'end')) {
        return
      }
      const step = stepNativeChatPromptRecall({
        direction: event.key === 'ArrowUp' ? 'back' : 'forward',
        prompts: nativeChatSentPrompts(recall.source),
        position: recall.position,
        draft
      })
      if (step) {
        event.preventDefault()
        recall.setPosition(step.position)
        setDraft(step.draft)
        setCaret(step.draft.length)
        recall.show(step.draft)
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
      interrupt,
      isComposing,
      mentionFiles,
      send,
      steerQueued,
      setActiveSuggestion,
      setCaret,
      setDraft
    ]
  )
}
