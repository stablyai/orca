import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function create(content: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })
}

it.each([
  'Use `` `value` `` here.',
  'Use ``` a``b`c ``` here.',
  'Use `` ` `` here.',
  'Use `` `value `` here.',
  'Use `` value` `` here.',
  'Link [`` `value` ``](https://example.com).',
  'Ordinary `code` stays code.',
  'Ordinary `code` and `` `value` `` stay separate.',
  'Long `````` a`````b `````` stays code.',
  '- Use `` `value` ``.\n- Next',
  '| Code |\n|---|\n| `` `value` `` |',
  'Use [`` ` ``](https://example.com)`` ` ``.',
  'Use `` ` ``[`` ` ``](https://example.com)`` ` ``.',
  'Use [`` ` ``](https://example.com)[`` ` ``](https://other.example.com).',
  'Use [`` ` ``tail](https://example.com).'
])('retains literal backticks and code marks in %j', (source) => {
  const editor = create(source)
  try {
    const before = editor.getJSON()
    const reopened = create(editor.getMarkdown())
    try {
      expect(reopened.getJSON()).toEqual(editor.getJSON())
      expect(editor.getJSON()).toEqual(before)
    } finally {
      reopened.destroy()
    }
  } finally {
    editor.destroy()
  }
})

it('chooses delimiters from the current code span in each editor', () => {
  const first = create('Use ```` a```b ```` here.')
  const second = create('Use `plain` here.')
  try {
    expect(first.getMarkdown()).toContain('```` a```b ````')
    expect(second.getMarkdown()).toContain('`plain`')
    first.commands.setContent('Use `ordinary` here.', { contentType: 'markdown' })
    expect(first.getMarkdown()).toContain('`ordinary`')
    expect(second.getMarkdown()).toContain('`plain`')
  } finally {
    first.destroy()
    second.destroy()
  }
})

it('keeps distant short code spans small when another contains a long backtick run', () => {
  const ticks = '`'.repeat(2_000)
  const source = `\` ${ticks} \`\n\n${'Use `short`.\n\n'.repeat(100)}`
  const editor = create(source)
  try {
    const saved = editor.getMarkdown()
    expect(saved.match(/`short`/g)).toHaveLength(100)
    expect(saved.length).toBeLessThan(source.length * 3)
    const reopened = create(saved)
    try {
      expect(reopened.getJSON()).toEqual(editor.getJSON())
    } finally {
      reopened.destroy()
    }
  } finally {
    editor.destroy()
  }
})

describe('code delimiters after editing', () => {
  it('recomputes safe delimiters when a user types backticks into a code mark', () => {
    const editor = create('Use `value` here.')
    try {
      editor.view.dispatch(editor.state.tr.insertText('``', 6))
      const reopened = create(editor.getMarkdown())
      try {
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })
})
