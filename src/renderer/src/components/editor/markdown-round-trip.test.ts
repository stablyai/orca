import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import type { SlashCommandId } from './rich-markdown-commands'
import { slashCommands } from './rich-markdown-commands'

function roundTripMarkdown(content: string): string {
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions(),
    content: encodeRawMarkdownHtmlForRichEditor(content),
    contentType: 'markdown'
  })

  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function slashCommandMarkdown(commandId: SlashCommandId): string {
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions(),
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
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions(),
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

  it('preserves details blocks with raw html as passthrough html', () => {
    const input = '<details><summary><span>Toggle</span></summary><p><em>Body</em></p></details>\n'
    expect(roundTripMarkdown(input)).toBe(input.trimEnd())
  })

  it('preserves details blocks with unsupported attributes as passthrough html', () => {
    const input =
      '<details id="x"><summary class="s">Toggle</summary><p data-x="1">Body</p></details>\n'
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

  it('preserves markdown tables', () => {
    expect(roundTripMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n')).toContain('| a')
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

  it('does not encode invalid doc links', () => {
    const result = roundTripMarkdown('Empty [[]] and piped [[a|b]]\n')
    expect(result).toContain('[[]]')
    expect(result).toContain('[[a|b]]')
  })

  it('preserves doc links inside fenced code blocks as plain text', () => {
    const input = '```\n[[not-a-link]]\n```\n'
    expect(roundTripMarkdown(input)).toBe('```\n[[not-a-link]]\n```')
  })
})
