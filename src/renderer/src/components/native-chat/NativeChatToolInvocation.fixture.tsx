import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatToolLine } from './NativeChatToolLine'
import { NativeChatToolRun } from './NativeChatToolRun'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

function Invocations() {
  return (
    <div
      className="native-chat-appearance space-y-4 bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'exec_command',
          state: 'completed',
          input: {
            cmd: "printf '%s\\n' 'Review completed'",
            workdir: '/workspace/orca',
            timeout_ms: 10000
          }
        }}
        result={{ type: 'tool-result', output: 'Review completed' }}
      />
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'mcp__review_tools__SubagentHandoffWithCompleteReport',
          state: 'completed',
          input: {
            message: 'Specification review completed. All changed interfaces match the brief.',
            options: { recipients: ['parent'], final: true }
          }
        }}
        result={{ type: 'tool-result', output: '{"success":true,"message":"Report delivered"}' }}
      />
    </div>
  )
}

function expand(frame: HTMLElement) {
  for (const button of frame.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')) {
    button.click()
  }
}

export const wide = defineFixture({ width: 780, render: Invocations, interact: expand })
export const narrow = defineFixture({ width: 360, render: Invocations, interact: expand })

const shortCommand = "printf '%s' 'the-final-word-of-this-narrow-row-must-remain-inspectable'"
function ShortCommandRun() {
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatToolRun
        blocks={[
          {
            type: 'tool-call',
            name: 'exec_command',
            input: { cmd: shortCommand, workdir: '/workspace/orca' },
            state: 'completed'
          },
          { type: 'tool-result', output: 'probe completed' }
        ]}
        expandSignal={false}
      />
    </div>
  )
}

async function expandShortCommand(frame: HTMLElement) {
  frame.querySelector<HTMLButtonElement>('[data-native-chat-tool-run-state]')?.click()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const target = Array.from(frame.querySelectorAll<HTMLSpanElement>('span[title]')).find(
    (node) => node.title === shortCommand
  )
  if (!target || shortCommand.length >= 80) {
    throw new Error('The short command preview is missing')
  }
  if (target.scrollWidth <= target.clientWidth) {
    throw new Error('The regression needs a command clipped by the row width')
  }
  target.closest('button')?.click()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

export const shortCommandExpanded = defineFixture({
  width: 390,
  render: ShortCommandRun,
  interact: expandShortCommand
})
export const shortCommandVerified = defineFixture({
  width: 390,
  render: ShortCommandRun,
  interact: async (frame) => {
    await expandShortCommand(frame)
    const input = frame.querySelector('[data-native-chat-tool-invocation] pre')
    if (!input || JSON.parse(input.textContent ?? '{}').cmd !== shortCommand) {
      throw new Error('The full CSS-clipped command is not available after expansion')
    }
    if (input.getBoundingClientRect().right > frame.getBoundingClientRect().right + 1) {
      throw new Error('The invocation detail overflows the narrow viewport')
    }
  }
})
