import { useEffect, useRef, useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMessageRail } from './NativeChatMessageRail'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'

const slots: never[] = []
const turnRows = { messages: [], turnKeys: [] }
const outline = Array.from({ length: 10_000 }, (_, index) => ({
  id: `question-${index}`,
  text: `Question ${index}: Find this earlier question in a long conversation.`,
  hasImages: false
}))

function MessageDirectory({ count }: { count: number }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const [entries] = useState(() => outline.slice(0, count))
  const [selected, setSelected] = useState('None')
  const rail = useNativeChatMessageRail({
    scrollRef,
    slots,
    turnRows,
    virtualItems: slots,
    outline: entries
  })
  const { onActivate } = rail
  useEffect(() => {
    onActivate(`question-${count - 1}`)
  }, [count, onActivate])

  return (
    <div className="native-chat-appearance relative h-[640px] bg-background text-foreground">
      <div ref={scrollRef} className="scrollbar-sleek h-full overflow-y-auto p-6">
        <input aria-label="Composer" />
        <output aria-label="Selected message">{selected}</output>
      </div>
      <NativeChatMessageRail
        rail={rail}
        railRef={railRef}
        scrollRef={scrollRef}
        onSelect={(item) => {
          setSelected(item.id)
          rail.onActivate(item.id)
        }}
      />
    </div>
  )
}

export const shortConversation = defineFixture({
  width: 900,
  render: () => <MessageDirectory count={8} />
})

export const longConversation = defineFixture({
  width: 900,
  render: () => <MessageDirectory count={10_000} />
})
