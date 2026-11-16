import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'

function QueueActivity({ text, stopping = false }: { text: string; stopping?: boolean }) {
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatTurnActivityLine
        line={{ thinking: true, stopping, activityText: text, reasoning: null }}
      />
    </div>
  )
}

export const queued = defineFixture({
  width: 720,
  render: () => <QueueActivity text="Queued (position 12)" />
})
export const narrow = defineFixture({
  width: 360,
  render: () => <QueueActivity text="Queued (position 12)" />
})
export const largePosition = defineFixture({
  width: 360,
  render: () => <QueueActivity text="Queued (position 9007199254740991)" />
})
export const unknownPosition = defineFixture({
  width: 360,
  render: () => <QueueActivity text="Queued" />
})
export const stopping = defineFixture({
  width: 360,
  render: () => <QueueActivity text="Queued (position 12)" stopping />
})
