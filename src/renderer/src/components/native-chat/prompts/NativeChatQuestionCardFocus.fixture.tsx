import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'

// A card that takes focus as it opens: its steps, picks and keyboard focus.
const dispatchOptions = [
  {
    label: 'Yes, investigate and report',
    description: "I'll find the config and summarize it."
  },
  {
    label: 'No, I know what it is',
    description: "You're already aware of it; I'll leave it alone."
  },
  {
    label: 'Ask me later',
    description: 'Keep the dispatches running for now.'
  }
]

function FocusedQuestion({ steps = 1, requiredStep }: { steps?: number; requiredStep?: number }) {
  return (
    // The pane's key scope, so arrow and number keys work as they do in chat.
    <div
      data-native-chat-root="true"
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatQuestionCard
        prompt={{
          questions: Array.from({ length: steps }, (_, i) => ({
            question:
              i === 0
                ? 'I found active dispatches from an automation I do not recognize. Should I look into it?'
                : 'Where should the report go?',
            header: i === 0 ? 'Investigate' : 'Report',
            multiSelect: false,
            options: dispatchOptions,
            ...(i === requiredStep ? { required: true as const } : {})
          }))
        }}
        onAnswer={() => {}}
        onCancel={() => {}}
        onCollapse={() => {}}
        shouldFocus
      />
    </div>
  )
}

// Keyboard focus as Tab would show it.
const focusOn =
  (find: (frame: HTMLElement) => HTMLElement | null | undefined) =>
  async (frame: HTMLElement): Promise<void> => {
    find(frame)?.focus({ focusVisible: true })
    await new Promise(requestAnimationFrame)
  }

// Keyboard focus on Skip: the same outline the options take.
export const keyboardFocus = defineFixture({
  width: 720,
  render: () => <FocusedQuestion />,
  interact: focusOn((frame) =>
    Array.from(frame.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Skip'))
  )
})

// Keyboard focus on a header button (Next question): the same outline, not the shared ring.
export const headerFocus = defineFixture({
  width: 720,
  render: () => <FocusedQuestion steps={2} />,
  interact: focusOn((frame) => frame.querySelector('button[aria-label="Next question"]'))
})

// The card takes focus as it opens; no option may look picked or ringed.
export const multiStep = defineFixture({
  width: 720,
  render: () => <FocusedQuestion steps={2} />
})

export const narrow = defineFixture({
  width: 400,
  render: () => <FocusedQuestion />
})

// Answered the first step, then skipped to the last: the footer offers Skip and submit.
export const skippedLastStep = defineFixture({
  width: 720,
  render: () => <FocusedQuestion steps={2} />,
  interact: async (frame) => {
    frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[0]?.click()
    frame.querySelectorAll<HTMLButtonElement>('[data-native-chat-question-step]')[1]?.click()
    await new Promise(requestAnimationFrame)
  }
})

// A single-select pick before its auto-advance: the tile fills, rings and its number turns into a check.
export const pickedSingle = defineFixture({
  width: 720,
  render: () => <FocusedQuestion />,
  interact: async (frame) => {
    frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[1]?.click()
    await new Promise(requestAnimationFrame)
  }
})

// Keyboard focus on an option: an outline outside the tile, never the picked look.
export const optionFocus = defineFixture({
  width: 720,
  render: () => <FocusedQuestion />,
  interact: focusOn((frame) => frame.querySelectorAll<HTMLElement>('button[aria-pressed]')[1])
})

// Picked and keyboard-focused at once: the inner ring and check, plus the outside outline. One step,
// so the pick's auto-advance submits in place instead of moving to another step before the capture.
export const pickedFocus = defineFixture({
  width: 720,
  render: () => <FocusedQuestion />,
  interact: async (frame) => {
    const row = frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[1]
    row?.focus({ focusVisible: true })
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise(requestAnimationFrame)
  }
})

const questionStep = (frame: HTMLElement, index: number): HTMLButtonElement | undefined =>
  frame.querySelectorAll<HTMLButtonElement>(
    'button[data-native-chat-question-step]:not([aria-label="Previous question"]):not([aria-label="Next question"])'
  )[index]

// Answered the first step; the required last step keeps Submit idle until it is answered.
export const requiredLastStep = defineFixture({
  width: 720,
  render: () => <FocusedQuestion steps={2} requiredStep={1} />,
  interact: async (frame) => {
    frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[0]?.click()
    questionStep(frame, 1)?.click()
    await new Promise(requestAnimationFrame)
  }
})

// Skipped the required first step and pressed Submit on the last: the card returns to the first.
export const requiredSkippedStep = defineFixture({
  width: 720,
  render: () => <FocusedQuestion steps={2} requiredStep={0} />,
  interact: async (frame) => {
    questionStep(frame, 1)?.click()
    await new Promise(requestAnimationFrame)
    frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[0]?.click()
    await new Promise((resolve) => setTimeout(resolve, 600))
    await new Promise(requestAnimationFrame)
  }
})

// Answered step 1, then passed the required step 2 by its chip: the last step says Next, since its
// press returns there instead of sending.
export const requiredPassedStep = defineFixture({
  width: 720,
  render: () => <FocusedQuestion steps={3} requiredStep={1} />,
  interact: async (frame) => {
    questionStep(frame, 0)?.click()
    await new Promise(requestAnimationFrame)
    frame.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[0]?.click()
    await new Promise(requestAnimationFrame)
    questionStep(frame, 2)?.click()
    await new Promise(requestAnimationFrame)
  }
})
