// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from '../../markdown/render-mode/markdown-rich-mode'
import { createRichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'
import { createRichMarkdownKeyHandler } from '../commands/rich-markdown-key-handler'
import type { KeyHandlerContext } from '../commands/rich-markdown-key-handler-context'
import { commitRichMarkdownSerialization } from '../document/rich-markdown-serialization-commit'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { handleRichMarkdownEditorClick } from '../links/rich-markdown-editor-click-routing'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { normalizeEmptyListItems } from '../schema/rich-markdown-normalize'
import { FOOTNOTE_DEF_ATTR, FOOTNOTE_REF_ATTR } from './rich-markdown-footnote-navigation'

vi.mock('@/lib/keyboard/shortcut-platform', () => ({
  getShortcutPlatform: (): NodeJS.Platform => 'darwin'
}))

const TEST_KEY = '0123456789abcdef0123456789abcdef'

function createLinkContext() {
  return createRichMarkdownHtmlSuperscriptLinkContext({
    sourceFilePath: '/repo/README.md',
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo',
    sourceOwner: { kind: 'local' }
  })
}

function createEditor(content: string, element: HTMLElement | null = null): Editor {
  const codec = createRichMarkdownEditorCodec(TEST_KEY)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({
      codec,
      htmlSuperscriptLinks: true,
      htmlSuperscriptLinkContext: createLinkContext()
    }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec, { htmlSuperscriptLinks: true }),
    contentType: 'markdown'
  })
  normalizeEmptyListItems(editor)
  return editor
}

function serializeSource(source: string): string {
  const editor = createEditor(source)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

function collectFootnoteNodes(editor: Editor): { refs: string[]; defs: string[] } {
  const refs: string[] = []
  const defs: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'richMarkdownFootnoteReference') {
      refs.push(String(node.attrs.identifier ?? ''))
    } else if (node.type.name === 'richMarkdownFootnoteDefinition') {
      defs.push(String(node.attrs.identifier ?? ''))
    }
  })
  return { refs, defs }
}

function findTextPosition(editor: Editor, needle: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(needle)) {
      found = pos + node.text.indexOf(needle)
    }
  })
  if (found === -1) {
    throw new Error(`Missing text: ${needle}`)
  }
  return found
}

function findNodePosition(editor: Editor, typeName: string, identifier?: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (
      found === -1 &&
      node.type.name === typeName &&
      (identifier === undefined || node.attrs.identifier === identifier)
    ) {
      found = pos
    }
  })
  if (found === -1) {
    throw new Error(`Missing node ${typeName} (${identifier ?? 'any'})`)
  }
  return found
}

function createKeyHandlerContext(editor: Editor, root: HTMLDivElement | null): KeyHandlerContext {
  return {
    isMac: true,
    editorRef: { current: editor },
    rootRef: { current: root },
    lastCommittedMarkdownRef: { current: '' },
    originalSourceRef: { current: '' },
    baseCanonicalRef: { current: '' },
    reconcileRoundTripRef: { current: () => null },
    onContentChangeRef: { current: vi.fn() },
    onSaveRef: { current: vi.fn() },
    isEditingLinkRef: { current: false },
    slashMenuRef: { current: null },
    filteredSlashCommandsRef: { current: [] },
    selectedCommandIndexRef: { current: 0 },
    docLinkMenuRef: { current: null },
    filteredDocLinkRowsRef: { current: [] },
    selectedDocLinkIndexRef: { current: 0 },
    handleLocalImagePickRef: { current: vi.fn() },
    handleEmojiPickRef: { current: vi.fn() },
    typedEmptyOrderedListMarkerRef: { current: false },
    flushPendingSerialization: vi.fn(() => false),
    openSearchRef: { current: vi.fn() },
    linkBubbleOwnerId: 'test-owner',
    htmlSuperscriptLinkContext: createLinkContext(),
    openAnnotationPopoverRef: { current: vi.fn(() => true) },
    setIsEditingLink: vi.fn(),
    setLinkBubble: vi.fn(),
    setSelectedCommandIndex: vi.fn(),
    setSelectedDocLinkIndex: vi.fn(),
    setSlashMenu: vi.fn(),
    setDocLinkMenu: vi.fn()
  }
}

describe('rich Markdown GFM footnotes', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('admits standard GFM footnotes and preserves them across body and footnote edits', () => {
    const source = [
      'Body claim[^1] and tight refs[^2][^3].',
      '',
      'Note[^Note]: mid-line colon stays prose.',
      '',
      '[^1]: Single-line with [Orca](https://example.com) and `code`.',
      '[^2]: https://example.com/docs',
      '[^3]: Nested reference to [^multi].',
      '',
      '[^multi]: First paragraph.',
      '',
      '    Second paragraph with `[^1]`.',
      '',
      '    ```ts',
      '    const raw = "[^1]"',
      '    ```',
      '',
      '[^note]: Case-insensitive target.',
      '[^unused]: Unreferenced footnote definition.'
    ].join('\n')

    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()

    const editor = createEditor(source)
    const refs = {
      originalSourceRef: { current: source },
      baseCanonicalRef: { current: editor.getMarkdown() },
      lastCommittedMarkdownRef: { current: source }
    }
    try {
      editor.state.doc.check()
      expect(collectFootnoteNodes(editor)).toEqual({
        refs: ['1', '2', '3', 'Note', 'multi'],
        defs: ['1', '2', '3', 'multi', 'note', 'unused']
      })

      const bodyPos = findTextPosition(editor, 'Body claim')
      editor.view.dispatch(editor.state.tr.insertText('Updated ', bodyPos, bodyPos))
      const afterBodyEdit = commitRichMarkdownSerialization(editor, refs, serializeSource)
      expect(afterBodyEdit.didSerialize).toBe(true)
      expect(afterBodyEdit.markdown).toBe(source.replace('Body claim', 'Updated Body claim'))

      const notePos = findTextPosition(editor, 'First paragraph.')
      editor.view.dispatch(editor.state.tr.insertText('Edited ', notePos, notePos))
      const afterFootnoteEdit = commitRichMarkdownSerialization(editor, refs, serializeSource)
      expect(afterFootnoteEdit.markdown).toBe(
        source
          .replace('Body claim', 'Updated Body claim')
          .replace('First paragraph.', 'Edited First paragraph.')
      )

      const reopened = createEditor(afterFootnoteEdit.markdown)
      try {
        reopened.state.doc.check()
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it('admits large documents over 50k chars containing standard footnotes and blocks embedded reference links', () => {
    const padding = 'Standard paragraph prose without footnotes.\n\n'.repeat(1_200)
    const source = `${padding}Final sentence[^big].\n\n[^big]: Large document note.\n`
    expect(source.length).toBeGreaterThan(50_000)
    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()

    const withFootnoteRefDef = `${padding}Final sentence[^big].\n\n[^big]:\n    [ref]: https://example.com\n`
    expect(getMarkdownRichModeUnsupportedReason(withFootnoteRefDef)).toBe('reference-links')

    const withIndentedFootnoteRefDef = `${padding}Final sentence[^big].\n\n[^big]: First line.\n\n    [ref]: https://example.com\n`
    expect(getMarkdownRichModeUnsupportedReason(withIndentedFootnoteRefDef)).toBe('reference-links')
  })

  it('falls back to code mode for unroundtrippable footnote syntax and preserves reference-link blocking', () => {
    expect(getMarkdownRichModeUnsupportedReason('Text[^1].\n\n[^1]:no-space-after-colon\n')).toBe(
      'footnotes'
    )
    expect(
      getMarkdownRichModeUnsupportedReason(
        '> ````md\n> ```\n> ````\n\nText[^1].\n\n[^1]:no-space-after-colon\n'
      )
    ).toBe('footnotes')
    expect(
      getMarkdownRichModeUnsupportedReason(`Text.\n\n[^${'a'.repeat(257)}]: Overlong identifier\n`)
    ).toBe('footnotes')
    expect(
      getMarkdownRichModeUnsupportedReason('    const x = "[^1]"\n\n[^1]: Defined below code\n')
    ).toBe('footnotes')

    expect(getMarkdownRichModeUnsupportedReason('[ref]: https://example.com\n')).toBe(
      'reference-links'
    )
    expect(getMarkdownRichModeUnsupportedReason('[^has space]: https://example.com\n')).toBe(
      'reference-links'
    )
    expect(
      getMarkdownRichModeUnsupportedReason(
        'Body[^1].\n\n[^1]: Real footnote.\n\n[ref]: https://example.com\n'
      )
    ).toBe('reference-links')
    expect(
      getMarkdownRichModeUnsupportedReason('Body[^1].\n\n[^1]:\n    [ref]: https://example.com\n')
    ).toBe('reference-links')
  })

  it('keeps unindented prose outside footnotes after indented code and skips definitions inside HTML comments', () => {
    const indentedCodeSource = 'Body[^n].\n\n[^n]:\n        code\nOutside paragraph.\n'
    const indentedEditor = createEditor(indentedCodeSource)
    try {
      const topLevelTypes: string[] = []
      indentedEditor.state.doc.forEach((child) => {
        topLevelTypes.push(child.type.name)
      })
      expect(topLevelTypes).toEqual(['paragraph', 'richMarkdownFootnoteDefinition', 'paragraph'])
      expect(indentedEditor.state.doc.lastChild?.textContent).toBe('Outside paragraph.')
    } finally {
      indentedEditor.destroy()
    }

    const commentedDefSource =
      'Body[^ghost] and [^1].\n\n<!--\n[^ghost]: hidden\n-->\n\n[^1]: Real.\n'
    expect(getMarkdownRichModeUnsupportedReason(commentedDefSource)).toBeNull()
    const commentEditor = createEditor(commentedDefSource)
    try {
      expect(collectFootnoteNodes(commentEditor)).toEqual({ refs: ['1'], defs: ['1'] })
      expect(commentEditor.state.doc.firstChild?.textContent).toContain('[^ghost]')
    } finally {
      commentEditor.destroy()
    }
  })

  it('ignores code blocks, inline code, escapes, undefined refs, and inline links shaped like footnotes', () => {
    const source = [
      'Keep \\[^1], [^missing], `[^1]`, and [^1](https://example.com) beside [^1].',
      '',
      '```md',
      '[^1] and [^fake]: inside fenced code',
      '```',
      '',
      '> ```md',
      '> [^quoted-fake]: inside quoted fence',
      '> ```',
      '',
      '[^1]: Only real footnote.'
    ].join('\n')

    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
    const editor = createEditor(source)
    try {
      expect(collectFootnoteNodes(editor)).toEqual({
        refs: ['1'],
        defs: ['1']
      })
      const links: string[] = []
      editor.state.doc.descendants((node) => {
        for (const mark of node.marks) {
          if (mark.type.name === 'link') {
            links.push(`${node.text}:${String(mark.attrs.href)}`)
          }
        }
      })
      expect(links).toEqual(['^1:https://example.com'])
      expect(editor.state.doc.firstChild?.textContent).toContain('[^missing]')
      expect(editor.getMarkdown()).toContain('[^1](https://example.com)')

      const reopened = createEditor(editor.getMarkdown())
      try {
        expect(collectFootnoteNodes(reopened)).toEqual({ refs: ['1'], defs: ['1'] })
        expect(reopened.state.doc.firstChild?.textContent).toContain('[^missing]')
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })

  it('navigates bidirectionally between inline references and definitions via click and Enter', () => {
    const source = [
      'Jump from here[^1].',
      '',
      '<details class="orca-details">',
      '<summary>Hidden notes</summary>',
      '',
      '[^1]: Target footnote inside toggle.',
      '',
      '</details>'
    ].join('\n')

    const root = document.createElement('div')
    const host = document.createElement('div')
    host.className = 'rich-markdown-editor'
    root.appendChild(host)
    document.body.appendChild(root)

    const editor = createEditor(source, host)
    try {
      const refElement = host.querySelector<HTMLElement>(`sup[${FOOTNOTE_REF_ATTR}="1"]`)
      const defElement = host.querySelector<HTMLElement>(`div[${FOOTNOTE_DEF_ATTR}="1"]`)
      const markerButton = defElement?.querySelector<HTMLButtonElement>(
        'button.rich-markdown-footnote-def-label'
      )
      const backButton = defElement?.querySelector<HTMLButtonElement>(
        'button.rich-markdown-footnote-def-backref'
      )
      expect(refElement?.querySelector('span[role="link"]')?.textContent).toBe('1')
      expect(markerButton?.textContent).toBe('1.')
      expect(backButton?.textContent).toBe('\u21a9')

      const defScrollSpy = vi.fn()
      const refScrollSpy = vi.fn()
      if (defElement) {
        defElement.scrollIntoView = defScrollSpy
      }
      if (refElement) {
        refElement.scrollIntoView = refScrollSpy
      }

      const refPos = findNodePosition(editor, 'richMarkdownFootnoteReference', '1')
      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
      Object.defineProperty(clickEvent, 'target', {
        value: refElement?.firstElementChild ?? refElement
      })
      const handledClick = handleRichMarkdownEditorClick({
        activateMarkdownLink: vi.fn(),
        editorRef: { current: editor },
        event: clickEvent,
        filePath: '/repo/README.md',
        isMac: true,
        htmlSuperscriptLinkContext: createLinkContext(),
        markdownCommentsRef: { current: [] },
        markdownSourceLineOffsetRef: { current: 0 },
        onOpenDocLinkRef: { current: undefined },
        pos: refPos,
        rootRef: { current: root },
        scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
        view: editor.view,
        worktreeId: 'worktree-1',
        worktreeRoot: '/repo'
      })
      expect(handledClick).toBe(true)
      expect(defScrollSpy).toHaveBeenCalledTimes(1)

      // Selecting the inline reference and pressing Enter jumps without deleting the node.
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, refPos))
      )
      const handleKeyDown = createRichMarkdownKeyHandler(createKeyHandlerContext(editor, root))
      const composingEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        cancelable: true
      })
      expect(handleKeyDown(editor.view, composingEnter)).toBe(false)
      expect(defScrollSpy).toHaveBeenCalledTimes(1)

      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      expect(handleKeyDown(editor.view, enterEvent)).toBe(true)
      expect(enterEvent.defaultPrevented).toBe(true)
      expect(defScrollSpy).toHaveBeenCalledTimes(2)
      expect(collectFootnoteNodes(editor).refs).toEqual(['1'])

      // Shift+Arrow range selection spanning only the inline reference also jumps on Enter.
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, refPos, refPos + 1))
      )
      const rangeEnterEvent = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      expect(handleKeyDown(editor.view, rangeEnterEvent)).toBe(true)
      expect(rangeEnterEvent.defaultPrevented).toBe(true)
      expect(defScrollSpy).toHaveBeenCalledTimes(3)
      expect(collectFootnoteNodes(editor).refs).toEqual(['1'])

      // Clicking either the definition marker or backref button jumps back to the inline reference.
      markerButton?.click()
      expect(refScrollSpy).toHaveBeenCalledTimes(1)
      backButton?.click()
      expect(refScrollSpy).toHaveBeenCalledTimes(2)
    } finally {
      editor.destroy()
      root.remove()
    }
  })

  it('escapes empty footnote paragraphs with Enter and unwraps empty definitions with Backspace', () => {
    const pressKey = (targetEditor: Editor, key: string): boolean => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      return Boolean(
        targetEditor.view.someProp('handleKeyDown', (handler) => handler(targetEditor.view, event))
      )
    }

    const multiHost = document.createElement('div')
    document.body.appendChild(multiHost)
    const editor = createEditor('Intro[^1].\n\n[^1]: First line.\n\n    Second line.', multiHost)
    try {
      const defPos = findNodePosition(editor, 'richMarkdownFootnoteDefinition', '1')
      const defNode = editor.state.doc.nodeAt(defPos)!
      const secondParaEnd = defPos + defNode.nodeSize - 2
      editor.commands.setTextSelection(secondParaEnd)
      // Enter after content adds a third empty paragraph inside the definition; a second Enter exits below it.
      expect(pressKey(editor, 'Enter')).toBe(true)
      expect(editor.state.doc.nodeAt(defPos)?.childCount).toBe(3)
      expect(pressKey(editor, 'Enter')).toBe(true)
      expect(editor.state.doc.nodeAt(defPos)?.childCount).toBe(2)
      expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
      expect(editor.state.selection.$from.depth).toBe(1)
    } finally {
      editor.destroy()
      multiHost.remove()
    }

    const emptyHost = document.createElement('div')
    document.body.appendChild(emptyHost)
    const emptyDefEditor = createEditor('Intro[^1].\n\n[^1]:', emptyHost)
    try {
      const defPos = findNodePosition(emptyDefEditor, 'richMarkdownFootnoteDefinition', '1')
      emptyDefEditor.commands.setTextSelection(defPos + 2)
      expect(pressKey(emptyDefEditor, 'Enter')).toBe(true)
      expect(emptyDefEditor.state.selection.$from.parent.type.name).toBe('paragraph')
      expect(emptyDefEditor.state.selection.$from.depth).toBe(1)

      // Backspace inside a single empty paragraph unwraps the footnote definition into a plain paragraph.
      emptyDefEditor.commands.setTextSelection(defPos + 2)
      expect(pressKey(emptyDefEditor, 'Backspace')).toBe(true)
      expect(collectFootnoteNodes(emptyDefEditor).defs).toEqual([])
      expect(emptyDefEditor.state.selection.$from.depth).toBe(1)
    } finally {
      emptyDefEditor.destroy()
      emptyHost.remove()
    }

    const codeHost = document.createElement('div')
    document.body.appendChild(codeHost)
    const codeDefEditor = createEditor('Intro[^1].\n\n[^1]:\n    ```ts\n    \n    ```', codeHost)
    try {
      const defPos = findNodePosition(codeDefEditor, 'richMarkdownFootnoteDefinition', '1')
      const codePos = defPos + 1
      const codeNode = codeDefEditor.state.doc.nodeAt(codePos)!
      expect(codeNode.type.name).toBe('codeBlock')
      codeDefEditor.view.dispatch(
        codeDefEditor.state.tr.delete(codePos + 1, codePos + 1 + codeNode.content.size)
      )
      codeDefEditor.commands.setTextSelection(codePos + 1)
      expect(pressKey(codeDefEditor, 'Enter')).toBe(true)
      expect(codeDefEditor.state.selection.$from.parent.type.name).toBe('codeBlock')
      expect(codeDefEditor.state.doc.nodeAt(defPos)?.childCount).toBe(1)
    } finally {
      codeDefEditor.destroy()
      codeHost.remove()
    }
  })

  it('round-trips footnote references and definitions through clipboard HTML', () => {
    const source = 'Copy me[^1].\n\n[^1]: Preserved note.'
    const host = document.createElement('div')
    const editor = createEditor(source, host)
    try {
      const html = editor.view.serializeForClipboard(
        editor.state.doc.slice(0, editor.state.doc.content.size)
      ).dom.innerHTML
      const pasted = createEditor('')
      try {
        pasted.commands.setContent(html, { contentType: 'html' })
        expect(collectFootnoteNodes(pasted)).toEqual({ refs: ['1'], defs: ['1'] })
        expect(pasted.getMarkdown()).toBe(source)
      } finally {
        pasted.destroy()
      }
    } finally {
      editor.destroy()
      host.remove()
    }
  })
})
