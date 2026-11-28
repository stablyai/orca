import { useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'

const DRAFT =
  'ultrathink about the retry bug, then ultraplan the fix and ultracode it. Leave `ultrathink` in quotes and src/ultracode.ts alone.'

function Composer({ claude }: { claude: boolean }): React.JSX.Element {
  const inputRef = useRef<NativeChatComposerInput>(null)
  return (
    <div className="native-chat-appearance p-4">
      <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs">
        <NativeChatPromptEditor
          inputRef={inputRef}
          initialValue={DRAFT}
          disabled={false}
          placeholder="Message Claude"
          claudeKeywords={claude}
          onChange={() => {}}
          onSelect={() => {}}
          className="min-h-14 w-full bg-transparent px-2 py-1 text-sm text-foreground outline-none"
        />
      </div>
    </div>
  )
}

/** A Claude chat colors the words as Claude Code's own prompt does; quoted or path uses stay plain. */
export const claude = defineFixture({ width: 520, render: () => <Composer claude /> })

/** Other agents don't read these words, so their composer leaves them plain. */
export const otherAgent = defineFixture({ width: 520, render: () => <Composer claude={false} /> })
