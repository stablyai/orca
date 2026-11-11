import { createRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'

export const listIndentation = defineFixture({
  width: 640,
  render: () => (
    <div className="native-chat-appearance bg-background p-4 text-chat-foreground">
      <div className="rounded-md border border-border bg-input p-3">
        <NativeChatPromptEditor
          inputRef={createRef<NativeChatComposerInput>()}
          initialValue={'- Improve the composer\n- Preserve the draft'}
          disabled={false}
          placeholder="Message"
          className="text-sm"
          onChange={() => {}}
          onSelect={() => {}}
        />
      </div>
    </div>
  )
})
