// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it, vi } from 'vitest'
import { marked } from 'marked'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import {
  createRichMarkdownEditorCodec,
  createRichMarkdownSourceTransport
} from './rich-markdown-source-transport'
import {
  classifyHtmlSuperscriptLinkAction,
  createRichMarkdownHtmlSuperscriptLinkContext
} from './rich-markdown-html-superscript-link-context'
import {
  HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT,
  matchHtmlSuperscriptLinkSource,
  parseHtmlSuperscriptLinkSource
} from './rich-markdown-html-superscript-link-source'
import { projectMarkdownHrefForClipboard } from './markdown-internal-links'
import { findRichMarkdownSearchMatches } from './rich-markdown-search'
import { findRichMarkdownSelectedTextRanges } from './rich-markdown-review-text-ranges'
import { getRichMarkdownVisibleText } from './rich-markdown-visible-text-map'
import { handleRichMarkdownCut } from './rich-markdown-cut-handler'
import { getSelectedHtmlSuperscriptLinkStatus } from './rich-markdown-selected-link-actions'
import { handleRichMarkdownCitationKey } from './rich-markdown-citation-keyboard'
import { resolveRichMarkdownWorktreeRoot } from './useRichMarkdownSuperscriptLinkSetup'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import {
  inspectRichMarkdownSourceOwningSlice,
  RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT
} from './rich-markdown-source-owning-slice'

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
  it('parses the reported fragment and preserves its exact source', () => {
    const source = '<sup><a href="https://example.com/source">[12]</a></sup>'
    const editor = createEditor(`研究结果${source}。`)
    try {
      expect(nodeNames(editor)).toContain('richMarkdownHtmlSuperscriptLink')
      expect(editor.getMarkdown()).toBe(`研究结果${source}。`)
      const citation = editor.state.doc.firstChild?.child(1)
      expect(citation?.attrs).toMatchObject({
        source,
        href: 'https://example.com/source',
        label: '[12]',
        title: null
      })
    } finally {
      editor.destroy()
    }
  })

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

  it('keeps sequential codecs isolated and exposes the complete marked surface', () => {
    const first = createRichMarkdownEditorCodec(TEST_KEY)
    const second = createRichMarkdownEditorCodec('fedcba9876543210fedcba9876543210')
    expect(Object.getOwnPropertyNames(first.marked).sort()).toEqual(
      Object.getOwnPropertyNames(marked).sort()
    )
    const authoredFirstToken = first.transport.create('inline-html', '<b>K1</b>')
    const editor = createEditor(authoredFirstToken, second.transport.key)
    try {
      expect(editor.getMarkdown()).toBe(authoredFirstToken)
      expect(nodeNames(editor)).not.toContain('rawMarkdownHtmlInline')
      expect(nodeNames(editor)).not.toContain('markdownDocLink')
    } finally {
      editor.destroy()
    }
  })

  it('keeps source matching linear across many rejected candidates', () => {
    const input = '<sup>'.repeat(2_000)
    let transitions = 0
    for (let index = 0; index < input.length; index += 5) {
      const stats = { transitions: 0 }
      expect(matchHtmlSuperscriptLinkSource(input, index, stats)).toBeNull()
      transitions += stats.transitions
    }
    expect(transitions).toBeLessThan(input.length * 4)
  })

  it('projects only browser-safe clipboard hrefs', () => {
    expect(projectMarkdownHrefForClipboard(' https://example.com ')).toBe('https://example.com')
    expect(projectMarkdownHrefForClipboard('#section')).toBe('#section')
    expect(projectMarkdownHrefForClipboard('./guide.md')).toBe('./guide.md')
    expect(projectMarkdownHrefForClipboard('javascript:alert(1)')).toBeNull()
    expect(projectMarkdownHrefForClipboard('java\nscript:alert(1)')).toBeNull()
    expect(projectMarkdownHrefForClipboard('C:\\repo\\guide.md')).toBeNull()
    expect(projectMarkdownHrefForClipboard('\\\\server\\share\\guide.md')).toBeNull()
    expect(projectMarkdownHrefForClipboard('//example.com/path')).toBeNull()
  })

  it('rejects duplicate attributes and parses quoted greater-than characters', () => {
    expect(
      parseHtmlSuperscriptLinkSource('<sup><a href="https://example.com/?q=>">[1]</a></sup>')?.href
    ).toBe('https://example.com/?q=>')
    expect(parseHtmlSuperscriptLinkSource('<sup><a href="a" href="b">[1]</a></sup>')).toBeNull()
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

  it('keeps whitespace and remote outside-root destinations non-actionable', () => {
    const local = {
      version: 0,
      sourceFilePath: '/repo/README.md',
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' as const }
    }
    expect(classifyHtmlSuperscriptLinkAction('   ', local)).toBe(false)
    expect(classifyHtmlSuperscriptLinkAction('file:///etc/passwd', local)).toBe(true)
    expect(
      classifyHtmlSuperscriptLinkAction('file:///etc/passwd', {
        ...local,
        sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' }
      })
    ).toBe(false)
    expect(
      classifyHtmlSuperscriptLinkAction('file:///etc/passwd', {
        ...local,
        sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'runtime-1' }
      })
    ).toBe(false)
  })

  it('scopes citation Tab focus to the selected editor bubble', () => {
    const editor = createEditor('<sup><a href="https://example.com">[12]</a></sup>')
    const firstBubble = document.createElement('div')
    firstBubble.dataset.richMarkdownLinkBubbleOwner = 'first-owner'
    const firstButton = document.createElement('button')
    firstBubble.appendChild(firstButton)
    const secondBubble = document.createElement('div')
    secondBubble.dataset.richMarkdownLinkBubbleOwner = 'second-owner'
    const secondButton = document.createElement('button')
    secondBubble.appendChild(secondButton)
    document.body.append(firstBubble, secondBubble)
    try {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 1)))
      const event = {
        key: 'Tab',
        shiftKey: false,
        isComposing: false,
        preventDefault: () => {}
      } as KeyboardEvent
      expect(
        handleRichMarkdownCitationKey({
          editor,
          event,
          linkBubbleOwnerId: 'second-owner'
        })
      ).toBe(true)
      expect(document.activeElement).toBe(secondButton)
    } finally {
      editor.destroy()
      firstBubble.remove()
      secondBubble.remove()
    }
  })

  it('uses a folder workspace path as the citation source root', () => {
    const state = {
      folderWorkspaces: [{ id: 'folder-1', folderPath: '/workspace/platform' }],
      worktreesByRepo: {}
    } as Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>
    expect(resolveRichMarkdownWorktreeRoot(state, folderWorkspaceKey('folder-1'))).toBe(
      '/workspace/platform'
    )
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

  it('rejects oversized clipboard source before UTF-8 encoding', () => {
    const editor = createEditor('')
    const oversizedSource = 'x'.repeat(HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT + 1)
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode')
    try {
      editor.commands.setContent(
        `<sup data-rich-markdown-html-superscript-link="1" data-orca-superscript-link-source="${oversizedSource}"><a>x</a></sup>`,
        { contentType: 'html' }
      )
      expect(nodeNames(editor)).not.toContain('richMarkdownHtmlSuperscriptLink')
      expect(encodeSpy.mock.calls.some(([value]) => value === oversizedSource)).toBe(false)
    } finally {
      encodeSpy.mockRestore()
      editor.destroy()
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

  it('enforces aggregate UTF-8 bounds even when oversized text precedes the citation', () => {
    const citation = '<sup><a href="https://example.com">[1]</a></sup>'
    const exactText = 'a'.repeat(RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT - 3)
    const exact = createEditor(`${exactText}${citation}`)
    try {
      expect(
        inspectRichMarkdownSourceOwningSlice(exact.state.doc.slice(0, exact.state.doc.content.size))
      ).toEqual({ containsSourceOwningNode: true, canPreserve: true })
    } finally {
      exact.destroy()
    }

    const over = createEditor(`${exactText}a${citation}`)
    try {
      expect(
        inspectRichMarkdownSourceOwningSlice(over.state.doc.slice(0, over.state.doc.content.size))
      ).toEqual({ containsSourceOwningNode: true, canPreserve: false })
    } finally {
      over.destroy()
    }

    const astralOver = createEditor(
      `${'😀'.repeat(Math.floor(RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT / 4))}${citation}`
    )
    try {
      expect(
        inspectRichMarkdownSourceOwningSlice(
          astralOver.state.doc.slice(0, astralOver.state.doc.content.size)
        )
      ).toEqual({ containsSourceOwningNode: true, canPreserve: false })
    } finally {
      astralOver.destroy()
    }
  })

  it('counts visible leaf serializers in source-owning slice bounds', () => {
    const editor = createEditor('')
    try {
      const schema = editor.state.schema
      const hardBreak = schema.nodes.hardBreak
      const docLink = schema.nodes.markdownDocLink
      const citation = schema.nodes.richMarkdownHtmlSuperscriptLink
      if (!hardBreak || !docLink || !citation) {
        throw new Error('Expected rich Markdown leaf node types')
      }
      const citationAttrs = {
        source: '<sup><a href="x">[1]</a></sup>',
        href: 'x',
        label: '[1]',
        title: null
      }
      const exactDoc = schema.node('doc', null, [
        schema.node('paragraph', null, [
          schema.text('a'.repeat(RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT - 4)),
          hardBreak.create(),
          citation.create(citationAttrs)
        ])
      ])
      expect(
        inspectRichMarkdownSourceOwningSlice(exactDoc.slice(0, exactDoc.content.size))
      ).toEqual({ containsSourceOwningNode: true, canPreserve: true })
      const overHardBreakDoc = schema.node('doc', null, [
        schema.node('paragraph', null, [
          schema.text('a'.repeat(RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT - 3)),
          hardBreak.create(),
          citation.create(citationAttrs)
        ])
      ])
      expect(
        inspectRichMarkdownSourceOwningSlice(
          overHardBreakDoc.slice(0, overHardBreakDoc.content.size)
        )
      ).toEqual({ containsSourceOwningNode: true, canPreserve: false })

      const oversizedLeafDoc = schema.node('doc', null, [
        schema.node('paragraph', null, [
          docLink.create({ target: 'Guide', label: 'x'.repeat(300_000) }),
          citation.create(citationAttrs)
        ])
      ])
      expect(
        inspectRichMarkdownSourceOwningSlice(
          oversizedLeafDoc.slice(0, oversizedLeafDoc.content.size)
        )
      ).toEqual({ containsSourceOwningNode: true, canPreserve: false })
    } finally {
      editor.destroy()
    }
  })

  it('remaps review text across adjacent citation atoms without inventing spaces', () => {
    const editor = createEditor(
      '<sup><a href="https://one.example">[1]</a></sup><sup><a href="https://two.example">[2]</a></sup>'
    )
    try {
      const ranges = findRichMarkdownSelectedTextRanges({ editor, selectedText: '[1][2]' })
      expect(ranges).toHaveLength(1)
      expect(ranges[0]).toEqual({ from: 1, to: 3 })
    } finally {
      editor.destroy()
    }
  })

  it('preserves block separators in visible text and review remapping', () => {
    const editor = createEditor('foo\n\nbar')
    try {
      expect(getRichMarkdownVisibleText(editor.state.doc)).toBe('foo\nbar')
      expect(findRichMarkdownSelectedTextRanges({ editor, selectedText: 'foo bar' })).toEqual([
        { from: 1, to: 4 },
        { from: 6, to: 9 }
      ])
    } finally {
      editor.destroy()
    }
  })

  it('maps dense search matches with a monotonic segment walk', () => {
    const citation = '<sup><a href="https://example.com">[1]</a></sup>'
    const editor = createEditor(`x${citation}`.repeat(200))
    try {
      const stats = { segmentVisits: 0 }
      expect(findRichMarkdownSearchMatches(editor.state.doc, 'x', undefined, stats)).toHaveLength(
        200
      )
      expect(stats.segmentVisits).toBeLessThan(1_000)
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
