import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatMemoryUpdatedRow } from './NativeChatMemoryUpdatedRow'

const Receipt = () => (
  <div className="native-chat-appearance bg-chat-canvas p-4">
    <p className="mb-3 text-sm text-chat-foreground">I saved the updated contact preference.</p>
    <NativeChatMemoryUpdatedRow
      note={{
        botId: 'fixture',
        added: ['Dana prefers Slack over a phone call'],
        removed: ['Dana prefers a phone call over Slack'],
        topics: ['memory/client.md'],
        otherChanges: 0
      }}
    />
  </div>
)
export const collapsed = defineFixture({ width: 640, render: () => <Receipt /> })
export const expanded = defineFixture({
  width: 640,
  render: () => <Receipt />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
  }
})
export const narrow = defineFixture({
  width: 360,
  render: () => <Receipt />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
  }
})
