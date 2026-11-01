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
const multilineDescription = 'Uses this computer.\nKeeps the current workspace.'

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
