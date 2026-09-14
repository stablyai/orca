import type { AskAnswerKeyGroup, AskAnswerSelection, AskPrompt } from './native-chat-ask'

const GROK_ENTER = '\r'
const GROK_NEXT_QUESTION = 'l'
const GROK_FREE_TEXT = 'z'
const GROK_NEXT_OPTION = '\x1b[B'
const GROK_TOGGLE_OPTION = ' '

function optionKey(index: number): string | null {
  if (index >= 0 && index < 9) {
    return String(index + 1)
  }
  if (index >= 9 && index < 15) {
    return String.fromCharCode('a'.charCodeAt(0) + index - 9)
  }
  return null
}

function selectedOptionIndices(
  question: AskPrompt['questions'][number],
  selection: AskAnswerSelection | undefined
): number[] {
  return [...new Set(selection?.indices ?? [])]
    .filter((index) => index >= 0 && index < question.options.length)
    .sort((left, right) => left - right)
}

/** Grok commits digit picks immediately; multi-selects toggle focused rows with Space. */
export function buildGrokAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const groups: AskAnswerKeyGroup[] = []

  prompt.questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    const other = (selection?.other ?? '').trim()
    const selectedIndices = selectedOptionIndices(question, selection)

    if (question.multiSelect) {
      let cursor = 0
      for (const index of selectedIndices) {
        while (cursor < index) {
          groups.push({ raw: GROK_NEXT_OPTION })
          cursor += 1
        }
        groups.push({ raw: GROK_TOGGLE_OPTION })
      }
      if (other) {
        groups.push({ raw: GROK_FREE_TEXT }, { text: other }, { raw: GROK_ENTER })
      } else if (selectedIndices.length > 0) {
        groups.push({ raw: GROK_ENTER })
      } else if (questionIndex < prompt.questions.length - 1) {
        groups.push({ raw: GROK_NEXT_QUESTION })
      }
      return
    }

    if (other) {
      const freeText = [question.options[selectedIndices[0] ?? -1]?.label, other]
        .filter(Boolean)
        .join(', ')
      groups.push({ raw: GROK_FREE_TEXT }, { text: freeText }, { raw: GROK_ENTER })
      return
    }

    const key = optionKey(selectedIndices[0] ?? -1)
    if (key) {
      groups.push({ raw: key })
    } else if (questionIndex < prompt.questions.length - 1) {
      groups.push({ raw: GROK_NEXT_QUESTION })
    }
  })

  return groups
}
