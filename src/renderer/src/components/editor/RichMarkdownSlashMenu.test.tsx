import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RichMarkdownSlashMenu } from './RichMarkdownSlashMenu'

describe('RichMarkdownSlashMenu', () => {
  it('keeps a visible search field when there are no matching blocks', () => {
    const html = renderToStaticMarkup(
      <RichMarkdownSlashMenu
        editor={null}
        slashMenu={{ query: 'zzz', from: 1, to: 5, left: 0, top: 0 }}
        filteredCommands={[]}
        selectedIndex={0}
        onImagePick={() => {}}
        onEmojiPick={() => {}}
      />
    )

    expect(html).toContain('aria-label="Search blocks"')
    expect(html).toContain('value="zzz"')
    expect(html).toContain('No blocks found')
  })
})
