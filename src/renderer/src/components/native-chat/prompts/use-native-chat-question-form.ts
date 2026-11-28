import { useEffect, useState } from 'react'
import type { AgentJournalFreeTextInput } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
import { useNativeChatViewMemory } from '../pane/ownership/native-chat-view-memory'
import {
  useReportNativeChatQuestionDraft,
  type NativeChatQuestionCardDraft
} from './NativeChatQuestionCardParts'

type QuestionForm = { index: number; selections: number[][]; otherText: string[] }

// Answered or cancelled forms are never told they're done (a Cancel the host refuses keeps the card); keeping only
// the newest few bounds them per chat.
const QUESTION_FORMS = 'question-form:'
const MAX_KEPT_QUESTION_FORMS = 4

/** The card's step, picks and typed text, kept with its chat tab under the prompt's identity when it has one. */
export function useNativeChatQuestionForm({
  prompt,
  freeTextInputs,
  draft,
  memoryKey
}: {
  prompt: AskPrompt
  freeTextInputs?: readonly (AgentJournalFreeTextInput | undefined)[]
  draft?: NativeChatQuestionCardDraft
  memoryKey?: string
}) {
  const memory = useNativeChatViewMemory<QuestionForm>(
    memoryKey === undefined ? undefined : `${QUESTION_FORMS}${memoryKey}`,
    MAX_KEPT_QUESTION_FORMS
  )
  const [index, setIndex] = useState(() => memory.saved?.index ?? 0)
  // Use indices because labels can repeat and the agent commits numbered rows.
  const [selections, setSelections] = useState<number[][]>(
    () => draft?.selections ?? memory.saved?.selections ?? prompt.questions.map(() => [])
  )
  const [otherText, setOtherText] = useState<string[]>(
    () =>
      draft?.otherText ??
      memory.saved?.otherText ??
      prompt.questions.map((_, qi) => freeTextInputs?.[qi]?.initialValue ?? '')
  )
  useReportNativeChatQuestionDraft(draft, selections, otherText)
  const { write } = memory
  useEffect(() => write({ index, selections, otherText }), [write, index, selections, otherText])
  return {
    index,
    setIndex,
    selections,
    setSelections,
    otherText,
    setOtherText
  }
}
