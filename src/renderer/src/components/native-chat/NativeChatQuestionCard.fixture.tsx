import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

function QuestionControls({ invertedAccent = false }: { invertedAccent?: boolean }) {
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={{
        ...nativeChatAppearanceStyle({}),
        ...(invertedAccent
          ? { '--accent': 'var(--foreground)', '--accent-foreground': 'var(--background)' }
          : {})
      }}
    >
      <NativeChatContextUsageRing
        usage={{
          usedTokens: 42_000,
          windowTokens: 200_000,
          percentage: 21,
          estimated: false,
          rows: []
        }}
      />
      <NativeChatQuestionCard
        prompt={{
          questions: [
            {
              question: 'Where should this run?',
              multiSelect: true,
              options: [
                { label: 'Local', description: 'Use this computer.' },
                { label: 'Remote', description: 'Use the connected host.' }
              ]
            }
          ]
        }}
        onAnswer={() => {}}
        onCancel={() => {}}
      />
    </div>
  )
}

export const standard = defineFixture({ width: 560, render: () => <QuestionControls /> })

export const invertedAccent = defineFixture({
  width: 560,
  render: () => <QuestionControls invertedAccent />,
  interact: (frame) => frame.querySelector<HTMLButtonElement>('button[aria-pressed]')?.click()
})

const multilineQuestion = 'Choose a target:\n\n- Keep changes local\n- Use the remote host'
const multilineDescription = 'Uses this computer.\n\nKeeps the current workspace.'

export const multiline = defineFixture({
  width: 560,
  render: () => (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatQuestionCard
        prompt={{
          questions: [
            {
              question: multilineQuestion,
              multiSelect: true,
              options: [
                { label: 'Local', description: multilineDescription },
                { label: 'Remote', description: 'Uses the connected host.' }
              ]
            }
          ]
        }}
        onAnswer={() => {}}
        onCancel={() => {}}
      />
    </div>
  ),
  interact: (frame) => {
    for (const text of [multilineQuestion, multilineDescription]) {
      const element = [...frame.querySelectorAll<HTMLElement>('p, span')].find(
        (node) => node.textContent === text && node.childNodes.length === 1
      )
      const node = element?.firstChild
      if (!element || !node) {
        throw new Error(`Missing multiline text: ${text}`)
      }
      const range = document.createRange()
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      let offset = 0
      let firstTop = 0
      for (const [index, line] of text.split('\n').entries()) {
        if (line) {
          range.setStart(node, offset)
          range.setEnd(node, offset + 1)
          const top = range.getBoundingClientRect().top
          if (index === 0) {
            firstTop = top
          }
          if (top - firstTop < index * lineHeight - 1) {
            throw new Error(`Line break collapsed before: ${line}`)
          }
        }
        offset += line.length + 1
      }
    }
  }
})

export const shortPane = defineFixture({
  width: 360,
  render: () => (
    <div
      data-short-question-pane
      data-native-chat-root="true"
      className="native-chat-appearance flex h-64 min-h-0 flex-col bg-chat-canvas"
      style={nativeChatAppearanceStyle({})}
    >
      <div className="h-8 shrink-0">Session header</div>
      <div className="min-h-0 flex-1" />
      <NativeChatQuestionCard
        shouldFocus
        prompt={{
          questions: Array.from({ length: 2 }, (_, step) => ({
            question: Array.from(
              { length: 24 },
              (_, i) => `Question ${step + 1} line ${i + 1}`
            ).join('\n'),
            multiSelect: true,
            options: Array.from({ length: 12 }, (_, option) => ({
              label: `Target ${step + 1}.${option + 1}`,
              description: multilineDescription
            }))
          }))
        }}
        onAnswer={() => {}}
        onCancel={() => {}}
      />
    </div>
  ),
  interact: async (frame) => {
    const pane = frame.querySelector<HTMLElement>('[data-short-question-pane]')
    const card = frame.querySelector<HTMLElement>('[role="group"]')
    const input = frame.querySelector<HTMLInputElement>('[data-native-chat-answer-field]')
    if (!pane || !card || !input) {
      throw new Error('Missing short-pane question controls')
    }
    const paneBounds = pane.getBoundingClientRect()
    const cardBounds = card.getBoundingClientRect()
    if (cardBounds.top < paneBounds.top || cardBounds.bottom > paneBounds.bottom + 1) {
      throw new Error('Question card overflows the short pane')
    }
    const firstOption = card.querySelector('button[aria-pressed]')
    if (document.activeElement !== firstOption || card.scrollTop !== 0) {
      throw new Error('Initial focus hides the start of the question')
    }
    const optionList = firstOption?.parentElement
    if (!optionList) {
      throw new Error('Missing question option list')
    }
    optionList.scrollTop = optionList.scrollHeight
    if (optionList.scrollTop === 0) {
      throw new Error('Option list does not exercise nested scrolling')
    }
    card.scrollTop = card.scrollHeight
    if (card.scrollTop === 0) {
      throw new Error('Long question cannot scroll to its answer controls')
    }
    const answerRow = input.parentElement
    const submit = answerRow?.querySelector<HTMLButtonElement>('button')
    if (!submit) {
      throw new Error('Missing question confirmation button')
    }
    for (const control of [input, submit]) {
      const bounds = control.getBoundingClientRect()
      if (bounds.top < cardBounds.top || bounds.bottom > cardBounds.bottom + 1) {
        throw new Error('Answer control is outside the scrolled card')
      }
      if (
        !control.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        )
      ) {
        throw new Error('Answer control is clipped or covered')
      }
    }
    submit.focus()
    submit.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const title = card.querySelector('[data-testid="native-chat-question-card-title"]')
    if (!title?.textContent?.startsWith('Question 2 line 1')) {
      throw new Error('Question did not advance')
    }
    if (optionList.scrollTop !== 0) {
      throw new Error('First option remains hidden in the scrolled option list')
    }
    if (
      card.scrollTop !== 0 ||
      document.activeElement !== card.querySelector('button[aria-pressed]')
    ) {
      throw new Error('Question step retained stale scroll or lost option focus')
    }
  }
})
