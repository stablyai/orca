// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'

import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import {
  createRichMarkdownEditorCodec,
  createRichMarkdownSourceTransport
} from '../document/rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

import { findRichMarkdownSearchMatches } from '../search/rich-markdown-search'
import { findRichMarkdownSelectedTextRanges } from '../review/rich-markdown-review-text-ranges'

import { handleRichMarkdownCut } from '../clipboard/rich-markdown-cut-handler'
import { getSelectedHtmlSuperscriptLinkStatus } from '../links/rich-markdown-selected-link-actions'

const TEST_KEY = '0123456789abcdef0123456789abcdef'

function createEditor(content: string, key = TEST_KEY, element: HTMLElement | null = null): Editor {
  const codec = createRichMarkdownEditorCodec(key)
  const context = createRichMarkdownHtmlSuperscriptLinkContext({
    sourceFilePath: '/repo/README.md',
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo',
    sourceOwner: { kind: 'local' }
  })
  return new Editor({
    element,
    extensions: createRichMarkdownExtensions({
      codec,
      htmlSuperscriptLinks: true,
      htmlSuperscriptLinkContext: context
    }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec, {
      htmlSuperscriptLinks: true
    }),
    contentType: 'markdown'
  })
}

function nodeNames(editor: Editor): string[] {
  const names: string[] = []
  editor.state.doc.descendants((node) => {
    names.push(node.type.name)
  })
  return names
}

describe('rich Markdown HTML superscript links', () => {
  it('retains casing, whitespace, quote style, entities, title, and adjacency', () => {
    const first =
      "<SUP ><A title='A &amp; B' href='https://example.com/?a=1&amp;b=2'>[&notit;]</A ></SUP >"
    const second = '<sup><a href=#section>[13]</a></sup>'
    const editor = createEditor(`${first}${second}`)
    try {
      expect(
        nodeNames(editor).filter((name) => name === 'richMarkdownHtmlSuperscriptLink')
      ).toHaveLength(2)
      expect(editor.getMarkdown()).toBe(`${first}${second}`)
      const citation = editor.state.doc.firstChild?.firstChild
      expect(citation?.attrs.href).toBe('https://example.com/?a=1&b=2')
      expect(citation?.attrs.title).toBe('A & B')
    } finally {
      editor.destroy()
    }
  })

  it('leaves malformed and broadened HTML on the inert raw-source path', () => {
    const rejected = [
      '<sup><a href="">[12]<a></sup>',
      '<sup><a href="x" onclick="go()">[12]</a></sup>',
      '<sup><a href="x"><b>[12]</b></a></sup>',
      '<sup class="x"><a href="x">[12]</a></sup>',
      '<sup><a href="x">[12]\n</a></sup>',
      '<sup\n><a href="x">[12]</a></sup>',
      '<sup><a\n href="x">[12]</a></sup>',
      '<sup><a href =\n "x">[12]</a></sup>',
      '<sup><a href="x">[12]</a\n></sup>'
    ]
    for (const source of rejected) {
      const editor = createEditor(source)
      try {
        expect(nodeNames(editor)).not.toContain('richMarkdownHtmlSuperscriptLink')
        if (!source.includes('\n')) {
          expect(editor.getMarkdown()).toBe(source)
        }
      } finally {
        editor.destroy()
      }
    }
  })

  it('does not recognize citations inside inline or fenced code', () => {
    const source = '<sup><a href="https://example.com">[12]</a></sup>'
    const markdown = `\`${source}\`\n\n\`\`\`html\n${source}\n\`\`\``
    const editor = createEditor(markdown)
    try {
      expect(nodeNames(editor)).not.toContain('richMarkdownHtmlSuperscriptLink')
      expect(editor.getMarkdown()).toBe(markdown)
    } finally {
      editor.destroy()
    }
  })

  it('preserves authored current-key and legacy transport-looking text', () => {
    const transport = createRichMarkdownSourceTransport(TEST_KEY)
    const authored = `${transport.create('inline-html', '<b>authored</b>')} [[ORCA_RAW_HTML_INLINE:%3Ci%3Ex%3C%2Fi%3E]]`
    const editor = createEditor(authored)
    try {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!')
      expect(editor.getMarkdown()).toBe(`${authored}!`)
      expect(nodeNames(editor)).not.toContain('markdownDocLink')
    } finally {
      editor.destroy()
    }
  })

  it('renders inert live DOM while exposing link semantics through Orca context', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const source = '<sup><a href="https://example.com">[12]</a></sup>'
    const codec = createRichMarkdownEditorCodec(TEST_KEY)
    const context = createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '/repo/README.md',
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' }
    })
    const editor = new Editor({
      element: host,
      extensions: createRichMarkdownExtensions({
        codec,
        htmlSuperscriptLinks: true,
        htmlSuperscriptLinkContext: context
      }),
      content: encodeRawMarkdownHtmlForRichEditor(source, codec, {
        htmlSuperscriptLinks: true
      }),
      contentType: 'markdown'
    })
    try {
      const liveLabel = host.querySelector<HTMLElement>(
        'sup[data-rich-markdown-html-superscript-link] > span'
      )
      expect(liveLabel?.textContent).toBe('[12]')
      expect(liveLabel?.getAttribute('role')).toBe('link')
      expect(host.querySelector('sup a')).toBeNull()
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 1)))
      expect(getSelectedHtmlSuperscriptLinkStatus(editor, context)).toEqual({
        href: 'https://example.com',
        label: '[12]',
        openEnabled: true
      })
      context.update({
        sourceFilePath: '/repo/README.md',
        worktreeId: 'worktree-1',
        worktreeRoot: '/repo',
        sourceOwner: { kind: 'unknown' }
      })
      expect(liveLabel?.hasAttribute('role')).toBe(false)
      expect(getSelectedHtmlSuperscriptLinkStatus(editor, context)?.openEnabled).toBe(false)
    } finally {
      editor.destroy()
      host.remove()
    }
  })

  it('self-validates clipboard HTML and rejects a forged semantic mismatch', () => {
    const source = '<sup><a title="Source" href="./guide.md">[12]</a></sup>'
    const host = document.createElement('div')
    const editor = createEditor(source, TEST_KEY, host)
    try {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 1)))
      const html = editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML
      const pasted = createEditor('')
      try {
        pasted.commands.setContent(html, { contentType: 'html' })
        expect(pasted.getMarkdown()).toBe(source)
      } finally {
        pasted.destroy()
      }

      const template = document.createElement('template')
      template.innerHTML = html
      const anchor = template.content.querySelector('a')
      if (!anchor) {
        throw new Error('expected serialized citation anchor')
      }
      anchor.textContent = '[99]'
      const forged = createEditor('')
      try {
        forged.commands.setContent(template.innerHTML, { contentType: 'html' })
        expect(nodeNames(forged)).not.toContain('richMarkdownHtmlSuperscriptLink')
        expect(forged.state.doc.textContent).toContain('[99]')
      } finally {
        forged.destroy()
      }

      anchor.textContent = '[12]'
      anchor.before('hidden sibling')
      const siblingForged = createEditor('')
      try {
        siblingForged.commands.setContent(template.innerHTML, { contentType: 'html' })
        expect(nodeNames(siblingForged)).not.toContain('richMarkdownHtmlSuperscriptLink')
        expect(siblingForged.state.doc.textContent).toContain('hidden sibling')
      } finally {
        siblingForged.destroy()
      }
    } finally {
      editor.destroy()
      host.remove()
    }
  })

  it('maps citation labels into search, review, and empty-selection Cut', () => {
    const source = 'Before <sup><a href="https://example.com">[12]</a></sup> after'
    const editor = createEditor(source)
    try {
      const matches = findRichMarkdownSearchMatches(editor.state.doc, 'e [12] a')
      expect(matches).toHaveLength(1)
      expect(matches[0]?.touchesReadOnlyAtom).toBe(true)
      let citationPosition = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'richMarkdownHtmlSuperscriptLink') {
          citationPosition = pos
        }
      })
      const reviewRanges = findRichMarkdownSelectedTextRanges({
        editor,
        selectedText: 'Before [12] after'
      })
      expect(
        reviewRanges.some(
          (range) => range.from <= citationPosition && range.to >= citationPosition + 1
        )
      ).toBe(true)

      const citationHost = document.createElement('div')
      const citationOnly = createEditor(
        '<sup><a href="https://example.com">[12]</a></sup>',
        TEST_KEY,
        citationHost
      )
      try {
        citationOnly.view.dispatch(
          citationOnly.state.tr.setSelection(TextSelection.create(citationOnly.state.doc, 1))
        )
        const clipboard = new Map<string, string>()
        const event = {
          clipboardData: {
            setData: (type: string, value: string) => clipboard.set(type, value),
            getData: (type: string) => clipboard.get(type) ?? ''
          },
          preventDefault: () => {}
        } as unknown as ClipboardEvent
        expect(handleRichMarkdownCut(citationOnly.view, event)).toBe(true)
        expect(clipboard.get('text/plain')).toBe('[12]')
        expect(clipboard.get('text/html')).toContain('data-orca-superscript-link-source')
        expect(citationOnly.getMarkdown()).toBe('')
      } finally {
        citationOnly.destroy()
        citationHost.remove()
      }
    } finally {
      editor.destroy()
    }
  })

  it('does not let search bridge omitted atoms or block boundaries', () => {
    const docLink = createEditor('foo[[Guide]]bar')
    try {
      expect(findRichMarkdownSearchMatches(docLink.state.doc, 'foobar')).toEqual([])
      expect(
        findRichMarkdownSearchMatches(docLink.state.doc, 'Guide')[0]?.touchesReadOnlyAtom
      ).toBe(true)
    } finally {
      docLink.destroy()
    }

    const rawHtml = createEditor('foo<kbd>bar')
    try {
      expect(findRichMarkdownSearchMatches(rawHtml.state.doc, 'foobar')).toEqual([])
    } finally {
      rawHtml.destroy()
    }

    const blocks = createEditor('foo\n\nbar')
    try {
      expect(findRichMarkdownSearchMatches(blocks.state.doc, 'foobar')).toEqual([])
    } finally {
      blocks.destroy()
    }
  })
})
