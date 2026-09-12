import { describe, expect, it, vi } from 'vitest'
import { RichMarkdownParagraph } from './rich-markdown-paragraph'

vi.mock('@tiptap/extension-paragraph', async () => {
  const actual = (await vi.importActual('@tiptap/extension-paragraph')) as {
    Paragraph: { extend: (config: object) => { config: Record<string, unknown> } }
  }
  // Simulates a Tiptap upgrade that drops `parseMarkdown` from the upstream paragraph.
  const Paragraph = actual.Paragraph.extend({})
  Paragraph.config.parseMarkdown = undefined
  return { ...actual, Paragraph }
})

describe('RichMarkdownParagraph without an upstream markdown parser', () => {
  it('parses paragraphs through parseInline instead of throwing', () => {
    const parseInline = vi.fn(() => [{ type: 'text', text: 'Install the extension' }])
    const createNode = vi.fn((type: string, attrs: unknown, content: unknown) => ({
      type,
      attrs,
      content
    }))
    const parseMarkdown = RichMarkdownParagraph.config.parseMarkdown as (
      token: unknown,
      helpers: unknown
    ) => unknown
    const token = { type: 'paragraph', tokens: [{ type: 'text' }, { type: 'image' }] }

    expect(() => parseMarkdown(token, { createNode, parseInline })).not.toThrow()
    expect(createNode).toHaveBeenCalledWith('paragraph', undefined, [
      { type: 'text', text: 'Install the extension' }
    ])
  })
})
