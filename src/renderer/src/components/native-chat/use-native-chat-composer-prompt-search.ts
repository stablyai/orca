import { useMemo, useState } from 'react'
import {
  nativeChatSentPrompts,
  searchNativeChatSentPrompts,
  type NativeChatRecallSource,
  type NativeChatSentPrompt
} from './native-chat-sent-prompt-history'

/** `query` is the draft the index was picked on, so typing a new query starts at the newest match. */
export type NativeChatPromptSearchStep = { query: string; index: number }

/** Ctrl+R search over the chat's sent prompts, with the draft as its query. */
export type NativeChatComposerPromptSearch = {
  /** Newest first; null while the search is closed. */
  matches: readonly NativeChatSentPrompt[] | null
  activeIndex: number
  /** Null closes the search. */
  setStep: (step: NativeChatPromptSearchStep | null) => void
  choose: (prompt: string) => void
}

export function useNativeChatComposerPromptSearch(args: {
  draft: string
  source: NativeChatRecallSource | undefined
  choosePrompt: (prompt: string) => void
}): NativeChatComposerPromptSearch | undefined {
  const { draft, source, choosePrompt } = args
  const [step, setStep] = useState<NativeChatPromptSearchStep | null>(null)
  const open = step !== null
  const matches = useMemo(
    () =>
      open && source ? searchNativeChatSentPrompts(nativeChatSentPrompts(source), draft) : null,
    [open, source, draft]
  )
  if (!source) {
    return undefined
  }
  const lastIndex = Math.max((matches?.length ?? 0) - 1, 0)
  return {
    matches,
    activeIndex: step?.query === draft ? Math.min(step.index, lastIndex) : 0,
    setStep,
    choose: (prompt) => {
      setStep(null)
      choosePrompt(prompt)
    }
  }
}
