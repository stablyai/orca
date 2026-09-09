import { afterEach, describe, expect, it, vi } from 'vitest'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import {
  getMarkdownRichModeEligibility,
  getMarkdownRichModeUnsupportedMessage
} from './markdown-rich-mode'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getMarkdownRichModeUnsupportedMessage', () => {
  it('allows markdown tables once table nodes are available in rich mode', () => {
    expect(getMarkdownRichModeUnsupportedMessage('| a | b |\n| - | - |\n| 1 | 2 |\n')).toBeNull()
  })

  it('allows plain markdown content', () => {
    expect(getMarkdownRichModeUnsupportedMessage('# Title\n\n- one\n- two\n')).toBeNull()
  })

  it('allows common raw html in markdown files', () => {
    expect(getMarkdownRichModeUnsupportedMessage('Before <span>hi</span> after\n')).toBeNull()
  })

  it('allows markdown autolinks wrapped in angle brackets', () => {
    expect(
      getMarkdownRichModeUnsupportedMessage('See <https://example.com/docs> for details.\n')
    ).toBeNull()
  })

  it('allows code fences with language info strings', () => {
    expect(getMarkdownRichModeUnsupportedMessage('```ts\nconst answer = 42\n```\n')).toBeNull()
  })

  it('ignores table syntax inside fenced code blocks', () => {
    expect(
      getMarkdownRichModeUnsupportedMessage('```md\n| a | b |\n| - | - |\n| 1 | 2 |\n```\n')
    ).toBeNull()
  })

  it('ignores jsx-looking tags inside code spans and fences', () => {
    expect(getMarkdownRichModeUnsupportedMessage('Use `<Widget />` in docs.\n')).toBeNull()
    expect(getMarkdownRichModeUnsupportedMessage('```tsx\n<Widget />\n```\n')).toBeNull()
    expect(getMarkdownRichModeUnsupportedMessage('```tsx\r\n<Widget />\r\n```\r\n')).toBeNull()
  })

  it('allows angle brackets in ordinary prose', () => {
    expect(
      getMarkdownRichModeUnsupportedMessage('Use 1 < 2 and 3 > 2 in the example.\n')
    ).toBeNull()
  })

  it('allows bare lowercase placeholders in prose', () => {
    expect(
      getMarkdownRichModeUnsupportedMessage(
        'Use --host runtime:<id>, --output <path>, and --project <project-id>.\n'
      )
    ).toBeNull()
  })

  it('allows bare lowercase placeholders in large documents', () => {
    const content = `${'a'.repeat(50_001)}\nUse --host runtime:<id> and --project <project-id>.\n`

    expect(getMarkdownRichModeUnsupportedMessage(content)).toBeNull()
  })

  it('still blocks large documents with actual html or jsx', () => {
    const prefix = 'a'.repeat(50_001)

    expect(getMarkdownRichModeUnsupportedMessage(`${prefix}\n<span>text</span>\n`)).not.toBeNull()
    expect(getMarkdownRichModeUnsupportedMessage(`${prefix}\n<id>text</id>\n`)).not.toBeNull()
    expect(getMarkdownRichModeUnsupportedMessage(`${prefix}\n<Widget />\n`)).not.toBeNull()
    expect(
      getMarkdownRichModeUnsupportedMessage(`${prefix}\n<project-id value="1">\n`)
    ).not.toBeNull()
  })

  it('allows block html and mdx-like tags by preserving them as passthrough nodes', () => {
    expect(getMarkdownRichModeUnsupportedMessage('<Widget />\n')).toBeNull()
    expect(getMarkdownRichModeUnsupportedMessage('<div>block</div>\n')).toBeNull()
  })

  it('allows markdown files with front-matter', () => {
    expect(
      getMarkdownRichModeUnsupportedMessage('---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n')
    ).toBeNull()
  })

  it('allows TOML front-matter delimited by +++', () => {
    expect(getMarkdownRichModeUnsupportedMessage('+++\ntitle = "Hello"\n+++\nBody\n')).toBeNull()
  })

  it('allows front-matter with clean markdown body', () => {
    expect(
      getMarkdownRichModeUnsupportedMessage('---\ntitle: Docs\n---\n# Heading\n\n- one\n- two\n')
    ).toBeNull()
  })

  it('strips newline-heavy fenced code without splitting the full body', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const content = `${'```tsx\n<Widget />\n```\n'.repeat(10_000)}# Tail\n`

    expect(getMarkdownRichModeUnsupportedMessage(content)).toBeNull()

    expect(split).not.toHaveBeenCalled()
  })

  it('preserves newline-heavy embedded html without global fragment matching', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const content = `${'<span>hi</span>\n'.repeat(1_000)}Tail\n`

    expect(getMarkdownRichModeUnsupportedMessage(content)).toBeNull()

    const usedGlobalHtmlFragmentMatch = matchSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        pattern.global &&
        pattern.source.startsWith('<!--[\\s\\S]*?-->')
    )
    expect(usedGlobalHtmlFragmentMatch).toBe(false)
  })

  it('keeps unsupported content blocked when it also exceeds the size limit', () => {
    const content = `${'a'.repeat(RICH_MARKDOWN_MAX_SIZE_BYTES + 1)}<Widget />`

    expect(getMarkdownRichModeEligibility({ content, sizeOverridden: false })).toEqual({
      exceedsSizeLimit: true,
      unsupportedMessage: expect.any(String)
    })
    expect(getMarkdownRichModeEligibility({ content, sizeOverridden: true })).toEqual({
      exceedsSizeLimit: false,
      unsupportedMessage: expect.any(String)
    })
  })

  describe('reference-style link definitions', () => {
    it('blocks a real link reference definition', () => {
      expect(getMarkdownRichModeUnsupportedMessage('[id]: https://example.com\n')).not.toBeNull()
    })

    it('blocks a link reference definition with an angle-bracket destination and title', () => {
      expect(
        getMarkdownRichModeUnsupportedMessage('[id]: <https://example.com> "Title"\n')
      ).not.toBeNull()
    })

    it('blocks a link reference definition with a relative destination and single-quoted title', () => {
      expect(
        getMarkdownRichModeUnsupportedMessage("[id]: ./relative/path 'title'\n")
      ).not.toBeNull()
    })

    it('blocks a link reference definition indented up to three spaces', () => {
      expect(getMarkdownRichModeUnsupportedMessage('   [id]: https://example.com\n')).not.toBeNull()
    })

    it('blocks a link reference definition nested inside a blockquote', () => {
      expect(
        getMarkdownRichModeUnsupportedMessage('> [id]: https://example.com\n> uses [id] here\n')
      ).not.toBeNull()
    })

    it('blocks a link reference definition nested inside a list item', () => {
      expect(
        getMarkdownRichModeUnsupportedMessage('- [id]: https://example.com\n  uses [id] here\n')
      ).not.toBeNull()
    })

    it('blocks a link reference definition nested inside a blockquote inside a list item', () => {
      expect(
        getMarkdownRichModeUnsupportedMessage('- > [id]: https://example.com\n  > uses [id] here\n')
      ).not.toBeNull()
    })

    it('blocks a link reference definition nested inside a list item inside a blockquote', () => {
      expect(
        getMarkdownRichModeUnsupportedMessage('> - [id]: https://example.com\n>   uses [id] here\n')
      ).not.toBeNull()
    })

    it('blocks a link reference definition nested three levels deep', () => {
      expect(
        getMarkdownRichModeUnsupportedMessage(
          '> - > [id]: https://example.com\n>   > uses [id] here\n'
        )
      ).not.toBeNull()
    })

    it('allows a bracketed label followed by prose, not a link destination', () => {
      expect(getMarkdownRichModeUnsupportedMessage('[Bug]: text with spaces\n')).toBeNull()
    })

    it('allows a real GFM task list item', () => {
      // A task-list checkbox is `[ ]`/`[x]` followed directly by whitespace
      // and text, with no colon — `- [x]: done` is CommonMark's link
      // reference definition syntax (label `x`, destination `done`), not a
      // task item.
      expect(getMarkdownRichModeUnsupportedMessage('- [x] done\n')).toBeNull()
    })

    it('allows a bracketed label followed by prose starting with "this is"', () => {
      expect(getMarkdownRichModeUnsupportedMessage('[note]: this is prose\n')).toBeNull()
    })

    it('allows the reported issue title line', () => {
      expect(
        getMarkdownRichModeUnsupportedMessage(
          "[Bug]: Backspace at the start of the first line under a heading merges that line's text into the heading\n"
        )
      ).toBeNull()
    })

    it('conservatively blocks a pre-filter match in a document past the parse-size guard', () => {
      const content = `${'a'.repeat(50_001)}\n[Bug]: text with spaces\n`

      expect(getMarkdownRichModeUnsupportedMessage(content)).not.toBeNull()
    })

    it('still parses to confirm a pre-filter match at or under the parse-size guard', () => {
      const content = `${'a'.repeat(49_970)}\n[Bug]: text with spaces\n`

      expect(getMarkdownRichModeUnsupportedMessage(content)).toBeNull()
    })
  })
})
