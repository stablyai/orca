import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatTurnDiffRollup } from './NativeChatTurnDiffRollup'
import { nativeChatTurnDiffs } from '../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

const messages: NativeChatMessage[] = [
  {
    id: 'edits',
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      {
        type: 'tool-call',
        name: 'Edit',
        state: 'completed',
        input: {
          file_path: 'src/components/greeting.ts',
          old_string: 'return "Hello"',
          new_string: 'return `Hello, ${name}`'
        }
      },
      { type: 'tool-result', output: 'The file was updated successfully.' },
      { type: 'tool-call', name: 'Diff', input: { path: 'src/components/status.ts' } },
      {
        type: 'tool-result',
        output: '@@ -1 +1 @@\n-export const ready = false\n+export const ready = true'
      }
    ]
  }
]
const diff = nativeChatTurnDiffs(messages, ['turn']).get('turn')!
export const settled = defineFixture({
  width: 560,
  render: () => <NativeChatTurnDiffRollup diff={diff} />
})
export const opened = defineFixture({
  width: 560,
  render: () => <NativeChatTurnDiffRollup diff={diff} />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
  }
})
