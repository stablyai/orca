import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatMarkdown } from './NativeChatMarkdown'

const content = [
  '**Result** [[Implement]] [[Done]] The tests now pass.',
  '',
  '**Check** [[Needs you]] Review the last change.',
  '',
  '**Risk** [[Blocked]] The deploy needs approval.',
  '',
  'Inline code stays literal: `[[Done]]`.'
].join('\n')

function example(piEmphasis: boolean) {
  return defineFixture({
    width: 520,
    render: () => (
      <NativeChatMarkdown
        className="bg-chat-pane p-5 text-sm text-chat-foreground"
        content={content}
        variant="document"
        piEmphasis={piEmphasis}
      />
    )
  })
}

export const before = example(false)
export const after = example(true)
