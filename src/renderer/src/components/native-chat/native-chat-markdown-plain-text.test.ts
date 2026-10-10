import { describe, expect, it } from 'vitest'
import { nativeChatMarkdownPlainText } from './native-chat-markdown-plain-text'

describe('nativeChatMarkdownPlainText', () => {
  it('keeps the words of headings and inline formatting without their syntax', () => {
    expect(
      nativeChatMarkdownPlainText(
        '## Summary\n\nRun **`pnpm tc`** before you _push_, ~~not after~~.'
      )
    ).toBe('Summary\n\nRun pnpm tc before you push, not after.')
  })

  it('keeps list markers, numbering and nesting', () => {
    expect(
      nativeChatMarkdownPlainText('3. **First**\n4. Second\n   - nested `one`\n   - [x] done')
    ).toBe('3. First\n4. Second\n   - nested one\n   - [x] done')
  })

  it('copies a code block as its code alone', () => {
    expect(nativeChatMarkdownPlainText('Then:\n\n```ts\nconst a = `*b*`\n\nrun()\n```')).toBe(
      'Then:\n\nconst a = `*b*`\n\nrun()'
    )
  })

  it('keeps a web address a link label hides, and drops other targets', () => {
    expect(
      nativeChatMarkdownPlainText(
        'See [the docs](https://example.com/docs), https://example.com and [app.ts](src/app.ts:12).'
      )
    ).toBe('See the docs (https://example.com/docs), https://example.com and app.ts.')
  })

  it('lays a table out as tab-separated rows', () => {
    expect(
      nativeChatMarkdownPlainText('| Name | Use |\n| --- | --- |\n| `rg` | **search** |')
    ).toBe('Name\tUse\nrg\tsearch')
  })

  it('drops quote markers, rules and tags, and keeps literal characters', () => {
    expect(
      nativeChatMarkdownPlainText('> quoted *text*\n\n---\n\nPress <kbd>Esc</kbd>, 2 \\* 3 = 6')
    ).toBe('quoted text\n\nPress Esc, 2 * 3 = 6')
  })
})
