import { useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'

function Composer({
  value,
  pickerOpen = false
}: {
  value: string
  pickerOpen?: boolean
}): React.JSX.Element {
  const inputRef = useRef<NativeChatComposerInput>(null)
  return (
    <div className="native-chat-appearance p-4">
      <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs">
        <NativeChatPromptEditor
          inputRef={inputRef}
          initialValue={value}
          disabled={false}
          placeholder="Message"
          onChange={() => {}}
          onSelect={() => {}}
          aria-expanded={pickerOpen}
          className="min-h-14 w-full bg-transparent px-2 py-1 text-sm text-foreground outline-none"
        />
      </div>
    </div>
  )
}

/** A line, a chip line with a comment, and a line. */
export const chipLine = defineFixture({
  width: 400,
  render: () => <Composer value={'x\n> q\n\ncd\nyy'} />
})

/** The chip line with a picker open, as after typing `@` in a comment. */
export const chipLinePicker = defineFixture({
  width: 400,
  render: () => <Composer value={'x\n> q\n\ncd\nyy'} pickerOpen />
})

/** One chip and no comment: the caret after it is at the end of the text. */
export const chipAtEnd = defineFixture({
  width: 400,
  render: () => <Composer value={'> q\n\n'} />
})
