import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatToolLine } from './NativeChatToolLine'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

function openEveryRow(frame: HTMLElement): void {
  for (const button of frame.querySelectorAll('button[aria-expanded="false"]')) {
    if (button instanceof HTMLButtonElement) {
      button.click()
    }
  }
}

export const openedInvocations = defineFixture({
  width: 640,
  interact: openEveryRow,
  render: () => (
    <div data-native-chat-root="true" style={nativeChatAppearanceStyle({})} className="p-3">
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'exec_command',
          input: { cmd: 'printf hello', workdir: '/repo', timeout_ms: 10000 },
          state: 'completed'
        }}
        result={{ type: 'tool-result', output: 'hello' }}
      />
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Read',
          input: { file_path: '/repo/src/main.ts', offset: 120, limit: 40 },
          state: 'completed'
        }}
        result={{ type: 'tool-result', output: 'export function main(): void {}' }}
      />
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'mcp__linear__save_comment',
          input: {
            issueId: 'ORC-1',
            body: 'Reproduced on main. The expanded row only showed the output, so the comment text the agent posted could not be checked from the chat.'
          },
          state: 'running'
        }}
      />
    </div>
  )
})
