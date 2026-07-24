import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import type { SlashCommandId } from './rich-markdown-slash-commands'
import { slashCommands } from './rich-markdown-slash-commands'

function roundTripMarkdown(content: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })

  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function markdownAfterTextReplace(content: string, search: string, replacement: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })

  try {
    let from: number | null = null
    editor.state.doc.descendants((node, pos) => {
      if (from !== null || !node.isText || !node.text) {
        return
      }
      const index = node.text.indexOf(search)
      if (index !== -1) {
        from = pos + index
      }
    })
    if (from === null) {
      throw new Error(`Missing text: ${search}`)
    }
    editor.view.dispatch(editor.state.tr.insertText(replacement, from, from + search.length))
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function slashCommandMarkdown(commandId: SlashCommandId): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: '',
    contentType: 'markdown'
  })

  try {
    const command = slashCommands.find((item) => item.id === commandId)
    if (!command) {
      throw new Error(`Missing slash command: ${commandId}`)
    }

    command.run(editor)
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function slashCommandSelectionParent(commandId: SlashCommandId): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: '',
    contentType: 'markdown'
  })

  try {
    const command = slashCommands.find((item) => item.id === commandId)
    if (!command) {
      throw new Error(`Missing slash command: ${commandId}`)
    }

    command.run(editor)
    return editor.state.selection.$from.parent.type.name
  } finally {
    editor.destroy()
  }
}

describe('rich markdown round trip', () => {
  it('preserves inline html inside paragraphs', () => {
    expect(roundTripMarkdown('Before <span>hi</span> after\n')).toBe('Before <span>hi</span> after')
  })

  it('preserves mdx-like inline tags', () => {
    expect(roundTripMarkdown('Use <Widget /> today\n')).toBe('Use <Widget /> today')
  })

  it('preserves block html and comments', () => {
    expect(roundTripMarkdown('<div>block</div>\n')).toBe('<div>block</div>')
    expect(roundTripMarkdown('<!-- comment -->\n')).toBe('<!-- comment -->')
  })

  it('preserves editable details blocks', () => {
    expect(roundTripMarkdown('<details><summary>Toggle</summary><p>Body</p></details>\n')).toBe(
      '<details class="orca-details">\n<summary>Toggle</summary>\n\nBody\n\n</details>'
    )
  })

  it('does not double-escape entities in editable details summaries', () => {
    expect(roundTripMarkdown('<details><summary>A &amp; B</summary><p>Body</p></details>\n')).toBe(
      '<details class="orca-details">\n<summary>A &amp; B</summary>\n\nBody\n\n</details>'
    )
  })

  it('preserves heading-styled details blocks', () => {
    expect(
      roundTripMarkdown(
        '<details data-orca-toggle="heading-1"><summary>Toggle</summary><p>Body</p></details>\n'
      )
    ).toBe(
      '<details class="orca-details" data-orca-toggle="heading-1">\n<summary>Toggle</summary>\n\nBody\n\n</details>'
    )
  })

  it.each(['heading-2', 'heading-3', 'heading-4', 'heading-5'])(
    'preserves %s-styled details blocks',
    (variant) => {
      expect(
        roundTripMarkdown(
          `<details data-orca-toggle="${variant}"><summary>Toggle</summary><p>Body</p></details>\n`
        )
      ).toBe(
        `<details class="orca-details" data-orca-toggle="${variant}">\n<summary>Toggle</summary>\n\nBody\n\n</details>`
      )
    }
  )

  it('preserves a heading toggle when its attribute uses HTML whitespace around equals', () => {
    expect(
      roundTripMarkdown(
        '<details data-orca-toggle = "heading-4"><summary>Toggle</summary><p>Body</p></details>\n'
      )
    ).toBe(
      '<details class="orca-details" data-orca-toggle="heading-4">\n<summary>Toggle</summary>\n\nBody\n\n</details>'
    )
  })

  it('preserves details blocks with raw html as passthrough html', () => {
    const input = '<details><summary><span>Toggle</span></summary><p><em>Body</em></p></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves details blocks with unsupported attributes as passthrough html', () => {
    const input =
      '<details id="x"><summary class="s">Toggle</summary><p data-x="1">Body</p></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves details blocks with unsupported toggle variants as passthrough html', () => {
    const input =
      '<details data-orca-toggle="heading-6"><summary>Toggle</summary><p>Body</p></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves details blocks with closing tags inside fenced code as passthrough html', () => {
    const input = [
      '<details><summary>Toggle</summary>',
      '',
      '```',
      '</details>',
      '```',
      '',
      '</details>',
      ''
    ].join('\n')
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves nested details blocks as passthrough html', () => {
    const input =
      '<details><summary>Outer</summary><details><summary>Inner</summary><p>Body</p></details></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves loose details and summary tags as passthrough html', () => {
    expect(roundTripMarkdown('<summary>Loose</summary>\n')).toBe('<summary>Loose</summary>')
    expect(roundTripMarkdown('<details>\n')).toBe('<details>')
  })

  it('inserts editable text toggles from slash commands', () => {
    expect(slashCommandMarkdown('toggle-text')).toBe(
      '<details class="orca-details" open>\n<summary></summary>\n\n\n\n</details>'
    )
    expect(slashCommandSelectionParent('toggle-text')).toBe('detailsSummary')
  })

  it('inserts editable heading toggles from slash commands', () => {
    expect(slashCommandMarkdown('toggle-h1')).toBe(
      '<details class="orca-details" data-orca-toggle="heading-1" open>\n<summary></summary>\n\n\n\n</details>'
    )
    expect(slashCommandSelectionParent('toggle-h1')).toBe('detailsSummary')
  })

  it.each([
    ['toggle-h2', 'heading-2'],
    ['toggle-h3', 'heading-3'],
    ['toggle-h4', 'heading-4'],
    ['toggle-h5', 'heading-5']
  ] as const)('inserts editable %s toggles from slash commands', (commandId, variant) => {
    expect(slashCommandMarkdown(commandId)).toBe(
      `<details class="orca-details" data-orca-toggle="${variant}" open>\n<summary></summary>\n\n\n\n</details>`
    )
    expect(slashCommandSelectionParent(commandId)).toBe('detailsSummary')
  })

  it('preserves markdown tables', () => {
    expect(roundTripMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n')).toContain('| a')
  })

  it('preserves encoded local image paths with screenshot filenames', () => {
    expect(roundTripMarkdown('![](Screenshot%202026-06-22%20at%203.37.19%20PM%20copy.png)\n')).toBe(
      '![](Screenshot%202026-06-22%20at%203.37.19%20PM%20copy.png)'
    )
  })

  it('preserves links whose label is inline code', () => {
    expect(roundTripMarkdown('Link to [`foo.md`](./foo.md) here\n')).toBe(
      'Link to [`foo.md`](./foo.md) here'
    )
  })

  it('preserves links whose label is inline code after an editor transaction', () => {
    expect(
      markdownAfterTextReplace('Link to [`foo.md`](./foo.md) here\n', 'here', 'here saved')
    ).toBe('Link to [`foo.md`](./foo.md) here saved')
  })

  it('preserves links when editing inside an inline-code label', () => {
    expect(markdownAfterTextReplace('Link to [`foo.md`](./foo.md) here\n', 'foo', 'bar')).toBe(
      'Link to [`bar.md`](./foo.md) here'
    )
  })

  it('preserves titled links whose label is inline code', () => {
    expect(roundTripMarkdown('Link to [`foo.md`](./foo.md "Foo") here\n')).toBe(
      'Link to [`foo.md`](./foo.md "Foo") here'
    )
  })

  it('preserves bold link labels as formatted link text', () => {
    expect(roundTripMarkdown('Link to [**bold**](./foo.md) here\n')).toBe(
      'Link to [**bold**](./foo.md) here'
    )
  })

  it('does not surface Linear issue reference definitions as description text', () => {
    const input = [
      '- [x] [H-279]',
      '- [ ] [H-284]',
      '',
      '[H-279]: https://linear.app/acme/issue/H-279/child-one "Child one"',
      '[H-284]: https://linear.app/acme/issue/H-284/child-two "Child two"',
      ''
    ].join('\n')

    expect(roundTripMarkdown(input)).toBe(
      [
        '- [x] [H-279](https://linear.app/acme/issue/H-279/child-one "Child one")',
        '- [ ] [H-284](https://linear.app/acme/issue/H-284/child-two "Child two")'
      ].join('\n')
    )
  })

  it('preserves doc links', () => {
    expect(roundTripMarkdown('See [[setup-guide]] for details\n')).toBe(
      'See [[setup-guide]] for details'
    )
  })

  it('preserves adjacent doc links', () => {
    expect(roundTripMarkdown('[[one]][[two]]\n')).toBe('[[one]][[two]]')
  })

  it('preserves doc links with paths', () => {
    expect(roundTripMarkdown('Link to [[docs/setup-guide.md]]\n')).toBe(
      'Link to [[docs/setup-guide.md]]'
    )
  })

  it('preserves aliased doc links', () => {
    expect(roundTripMarkdown('Link to [[docs/setup-guide.md|Setup Guide]]\n')).toBe(
      'Link to [[docs/setup-guide.md|Setup Guide]]'
    )
  })

  it('does not encode invalid doc links', () => {
    const result = roundTripMarkdown('Empty [[]] and blank alias [[a|]]\n')
    expect(result).toContain('[[]]')
    expect(result).toContain('[[a|]]')
  })

  it('preserves doc links inside fenced code blocks as plain text', () => {
    const input = '```\n[[not-a-link]]\n```\n'
    expect(roundTripMarkdown(input)).toBe('```\n[[not-a-link]]\n```')
  })
})
