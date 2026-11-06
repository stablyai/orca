// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { projectStructuredQuestion } from '../../../../../mobile/src/session/mobile-structured-agent-prompts'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session/agent-session-question-answer'
import {
  structuredQuestionAnswers,
  structuredQuestionCard
} from '../../../../shared/structured-agent-question-card'
import { acpFormElicitationPresentation } from '../../../../main/acp/acp-form-elicitation'
import { recordedOmpAskForm } from '../../../../main/acp/acp-omp-ask-form.test-fixture'
import openCodeForms from '../../../../main/acp/fixtures/opencode-v2-question-forms.json'
import type { AskPrompt } from '../../../../shared/native-chat/input/native-chat-ask-types'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function render(prompt: AskPrompt, onAnswer: () => void, allowOther: readonly boolean[]): void {
  act(() =>
    root.render(
      <NativeChatQuestionCard
        prompt={prompt}
        onAnswer={onAnswer}
        onCancel={() => {}}
        allowOther={allowOther}
      />
    )
  )
}
function cardTitle(): string | null | undefined {
  return container.querySelector('[data-testid="native-chat-question-card-title"]')?.textContent
}

it.each([
  {
    form: openCodeForms.single,
    message: 'Questions',
    title: 'Storage',
    description: 'Which storage?'
  },
  {
    form: openCodeForms.batch,
    message: 'Questions',
    title: 'Storage',
    description: 'Which storage?'
  },
  {
    form: recordedOmpAskForm,
    message: 'Answer 3 questions',
    title: 'Which database?',
    description: 'DB'
  },
  {
    form: {
      ...recordedOmpAskForm,
      requestedSchema: {
        properties: {
          q0: recordedOmpAskForm.requestedSchema.properties.q0,
          q0__other: recordedOmpAskForm.requestedSchema.properties.q0__other
        }
      }
    },
    message: 'Answer 3 questions',
    title: 'Which database?',
    description: 'DB'
  }
])(
  'shows the form message and full field instructions on the card: $title',
  ({ form, message, title, description }) => {
    const presentation = acpFormElicitationPresentation(form)
    if (presentation.body.kind !== 'question') {
      throw new Error('expected a question')
    }
    const card = structuredQuestionCard(presentation.body.questions!)
    render(card.prompt, () => {}, card.allowOther)
    expect(cardTitle()).toContain(message)
    expect(cardTitle()).toContain(title)
    expect(cardTitle()).toContain(description)
  }
)

it('roundtrips a phone batch with selected and custom multi answers through the shared encoding', () => {
  const form = acpFormElicitationPresentation(openCodeForms.batch)
  if (form.body.kind !== 'question') {
    throw new Error('expected a question')
  }
  const projected = projectStructuredQuestion({
    itemId: 'question-1',
    revision: 2,
    sequence: 1,
    observedAt: 1,
    body: form.body
  })!
  const questions = projected.questions!
  expect(structuredQuestionCard(questions).prompt.questions).toMatchObject([
    { question: 'Questions\n\nStorage\n\nWhich storage?' },
    { question: 'Questions\n\nFeatures\n\nWhich features?', multiSelect: true }
  ])
  const answers = structuredQuestionAnswers(questions, [
    { indices: [0] },
    { indices: [0, 2], other: 'Offline' }
  ])!
  expect(
    form.reply({ kind: 'option', optionId: encodeAgentSessionQuestionAnswers(answers) })
  ).toEqual({
    action: 'accept',
    content: { q0: 'SQLite', q1: ['Search', 'Sync'], q1_custom: 'Offline' }
  })
})
