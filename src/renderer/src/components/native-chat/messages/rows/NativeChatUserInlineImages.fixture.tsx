import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'

const picture = (color: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="${color}"/><circle cx="40" cy="34" r="14" fill="#fff"/></svg>`
  )}`
const image = (color: string, alt: string): NativeChatBlock => ({
  type: 'image-ref',
  url: picture(color),
  alt
})

function SentMessage({ text, images }: { text: string; images: NativeChatBlock[] }) {
  return (
    <MessageRow
      message={{
        id: 'sent',
        role: 'user',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'text', text }, ...images]
      }}
      runtimeContext={{ worktreeId: 'w', worktreePath: null, target: { kind: 'local' } }}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
    />
  )
}

/** Images pasted before, between and after the words are drawn exactly there. */
export const inline = defineFixture({
  width: 480,
  render: () => (
    <SentMessage
      text={
        '[Image #1]\nThe header looks off compared to\n[Image #2]\nand the footer here:\n- one\n- two\n[Image #3]\nThanks!'
      }
      images={[image('#6d5dfc', 'one'), image('#e0527a', 'two'), image('#2f9e7a', 'three')]}
    />
  )
})

/** An image whose marker is gone stays above the text, as before. */
export const unplaced = defineFixture({
  width: 480,
  render: () => (
    <SentMessage
      text="See [Image #2] below"
      images={[image('#6d5dfc', 'one'), image('#e0527a', 'two')]}
    />
  )
})
