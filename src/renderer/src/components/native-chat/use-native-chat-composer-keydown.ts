import { useCallback, type Dispatch, type KeyboardEventHandler, type SetStateAction } from 'react'
import type { DiscoveredSkill } from '../../../../shared/skills'
import {
  applySkillSuggestion,
  recallNext,
  recallPrevious,
  type ComposerAutocomplete,
  type HistoryState,
  type SlashCommandSuggestion
} from './native-chat-composer-state'

export type UseNativeChatComposerKeyDownArgs = {
  autocomplete: ComposerAutocomplete
  activeSuggestion: number
  draft: string
  caret: number
  history: HistoryState
  chooseSlash: (command: SlashCommandSuggestion) => void
  dispatchSlash: (command: SlashCommandSuggestion) => void
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
  caret,
  history,
  chooseSlash,
  dispatchSlash,
  interrupt,
  send,
  setActiveSuggestion,
  setDraft,
  setCaret,
  setHistory
}: UseNativeChatComposerKeyDownArgs): KeyboardEventHandler<HTMLTextAreaElement> {
  return useCallback(
    (event) => {
      if (autocomplete.mode === 'slash' && autocomplete.suggestions.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveSuggestion((i) => (i + 1) % autocomplete.suggestions.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveSuggestion(
            (i) => (i - 1 + autocomplete.suggestions.length) % autocomplete.suggestions.length
          )
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          dispatchSlash(autocomplete.suggestions[activeSuggestion] ?? autocomplete.suggestions[0])
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          chooseSlash(autocomplete.suggestions[activeSuggestion] ?? autocomplete.suggestions[0])
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setDraft('')
          setCaret(0)
          return
        }
      }

      if (autocomplete.mode === 'skill') {
        if (event.key === 'ArrowDown' && autocomplete.suggestions.length > 0) {
          event.preventDefault()
          setActiveSuggestion((i) => (i + 1) % autocomplete.suggestions.length)
          return
        }
        if (event.key === 'ArrowUp' && autocomplete.suggestions.length > 0) {
          event.preventDefault()
          setActiveSuggestion(
            (i) => (i - 1 + autocomplete.suggestions.length) % autocomplete.suggestions.length
          )
          return
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && autocomplete.suggestions.length > 0) {
          event.preventDefault()
          const skill = autocomplete.suggestions[activeSuggestion] ?? autocomplete.suggestions[0]
          applySkill({ skill, draft, caret, setDraft, setCaret, setActiveSuggestion })
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setDraft('')
          setCaret(0)
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
      autocomplete,
      activeSuggestion,
      chooseSlash,
      dispatchSlash,
      interrupt,
      send,
      draft,
      caret,
      history,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setHistory
    ]
  )
}

function applySkill({
  skill,
  draft,
  caret,
  setDraft,
  setCaret,
  setActiveSuggestion
}: {
  skill: DiscoveredSkill
  draft: string
  caret: number
  setDraft: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
}): void {
  const result = applySkillSuggestion(draft, caret, skill.name)
  setDraft(result.draft)
  setCaret(result.caret)
  setActiveSuggestion(0)
}
