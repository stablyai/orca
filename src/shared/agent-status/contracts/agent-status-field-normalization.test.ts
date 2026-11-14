import { describe, expect, it } from 'vitest'
import { normalizeInteractivePromptField } from './agent-status-field-normalization'
import { parseAskFromStatus } from '../../native-chat/input/native-chat-ask'

function layoutQuestion(preview: (index: number) => string): string {
  return JSON.stringify({
    questions: [
      {
        question: 'Which layout?',
        header: 'Layout',
        multiSelect: false,
        options: ['Sidebar', 'Top bar', 'Split', 'Tabs'].map((label, index) => ({
          label,
          description: `Layout ${index + 1}`,
          preview: preview(index)
        }))
      }
    ]
  })
}

describe('normalizeInteractivePromptField', () => {
  it('shortens oversize previews and keeps every option and the preview layout', () => {
    const fitted = normalizeInteractivePromptField(
      layoutQuestion((index) => `+--${index}--+\n`.repeat(600)),
      4000
    )
    const ask = parseAskFromStatus(fitted, 'AskUserQuestion')
    const question = ask!.questions[0]!
    expect(question.options.map((option) => option.label)).toEqual([
      'Sidebar',
      'Top bar',
      'Split',
      'Tabs'
    ])
    expect(question.hasPreviews).toBe(true)
    expect(question.options.every((option) => option.preview?.endsWith('…'))).toBe(true)
  })

  it('never turns blank previews into previews', () => {
    const fitted = normalizeInteractivePromptField(
      layoutQuestion(() => ' '.repeat(1200)),
      4000
    )
    const question = parseAskFromStatus(fitted, 'AskUserQuestion')!.questions[0]!
    expect(question.options).toHaveLength(4)
    expect(question.hasPreviews).toBeUndefined()
  })
})
