import { useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'

const DRAFT = [
  '# Plan',
  '## Steps',
  '### Notes',
  '> quoted **reply** from the bot',
  '> second quoted line',
  '- first point',
  '* second point with `code`',
  '1. numbered one',
  '2. numbered **two**',
  '---',
  'Plain with **bold**, *italic*, _italic_, ~~gone~~ and `inline`.',
  '```ts',
  'const answer = 42 // **not bold**',
  '```',
  'after the block'
].join('\n')

function Composer(): React.JSX.Element {
  const inputRef = useRef<NativeChatComposerInput>(null)
  return (
    <div className="native-chat-appearance p-4">
      <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs">
        <NativeChatPromptEditor
          inputRef={inputRef}
          initialValue={DRAFT}
          disabled={false}
          placeholder="Ask anything"
          onChange={() => {}}
          onSelect={() => {}}
          className="min-h-14 w-full bg-transparent px-2 py-1 text-sm text-foreground outline-none"
        />
      </div>
    </div>
  )
}

/** A draft with every markdown block the chat renders, styled in place while typing. */
export const markdownDraft = defineFixture({
  width: 560,
  render: () => <Composer />
})
