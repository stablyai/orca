// @vitest-environment happy-dom

import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'
import type { DocLinkMenuState } from './rich-markdown-commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMParser as DocumentParser } from '@tiptap/pm/model'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import {
  createRichMarkdownEditorConfig,
  type EditorConfigParams
} from './rich-markdown-editor-config'
import { slashCommands, type SlashMenuState } from './rich-markdown-slash-commands'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

vi.mock('./rich-markdown-editor-click-routing', () => ({
  handleRichMarkdownEditorClick: vi.fn()
}))

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function stateSetter<T>(): Dispatch<SetStateAction<T>> {
  return vi.fn() as Dispatch<SetStateAction<T>>
}

function getSpellcheckAttribute(config: ReturnType<typeof createRichMarkdownEditorConfig>): string {
  const attributes = config.editorProps?.attributes
  return typeof attributes === 'function'
    ? attributes({} as never).spellcheck
    : (attributes?.spellcheck ?? '')
}

function createConfigParams(overrides: Partial<EditorConfigParams> = {}): EditorConfigParams {
  const codec = createRichMarkdownEditorCodec()
  return {
    codec,
    htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '/repo/README.md',
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' }
    }),
    content: '',
    filePath: '/repo/README.md',
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo',
    runtimeEnvironmentId: null,
    isMac: false,
    richMarkdownSpellcheckEnabled: true,
    runtimeTarget: { kind: 'local' },
    activateMarkdownLink: vi.fn(),
    rootRef: ref<HTMLDivElement | null>(null),
    editorRef: ref<Editor | null>(null),
    lastCommittedMarkdownRef: ref(''),
    originalSourceRef: ref(''),
    baseCanonicalRef: ref(''),
    reconcileRoundTripRef: ref<(markdown: string) => string | null>(() => null),
    onContentChangeRef: ref(vi.fn()),
    onDirtyStateHintRef: ref(vi.fn()),
    onSaveRef: ref(vi.fn()),
    onOpenDocLinkRef: ref(undefined),
    isEditingLinkRef: ref(false),
    slashMenuRef: ref(null),
    filteredSlashCommandsRef: ref([]),
    selectedCommandIndexRef: ref(0),
    docLinkMenuRef: ref(null),
    filteredDocLinkRowsRef: ref([]),
    selectedDocLinkIndexRef: ref(0),
    handleLocalImagePickRef: ref(vi.fn()),
    handleEmojiPickRef: ref(vi.fn()),
    typedEmptyOrderedListMarkerRef: ref(false),
    cancelAutoFocusRef: ref(null),
    fileId: 'file-a',
    serializeTimerRef: ref(null),
    pendingEditEpochRef: ref(0),
    isInitializingRef: ref(false),
    isApplyingProgrammaticUpdateRef: ref(false),
    markdownCommentsRef: ref([]),
    markdownSourceLineOffsetRef: ref(0),
    flushPendingSerialization: vi.fn(),
    openSearchRef: ref(vi.fn()),
    openAnnotationPopoverRef: ref(vi.fn()),
    syncAnnotationTarget: vi.fn(),
    clearAnnotationTarget: vi.fn(),
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    setIsEditingLink: stateSetter<boolean>(),
    setLinkBubble: stateSetter<LinkBubbleState | null>(),
    setSelectedCommandIndex: stateSetter<number>(),
    setSelectedDocLinkIndex: stateSetter<number>(),
    setSlashMenu: stateSetter<SlashMenuState | null>(),
    setDocLinkMenu: stateSetter<DocLinkMenuState | null>(),
    ...overrides
  }
}

describe('createRichMarkdownEditorConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('disables browser spellcheck when the rich Markdown setting is off', () => {
    const config = createRichMarkdownEditorConfig(
      createConfigParams({ richMarkdownSpellcheckEnabled: false })
    )

    expect(getSpellcheckAttribute(config)).toBe('false')
  })

  it('keeps browser spellcheck enabled by default', () => {
    const config = createRichMarkdownEditorConfig(createConfigParams())

    expect(getSpellcheckAttribute(config)).toBe('true')
  })

  it('flushes pending serialization when the rich editor blurs', () => {
    const setMarkdownEditorFocused = vi.fn()
    vi.stubGlobal('window', {
      api: { ui: { setMarkdownEditorFocused } }
    })
    const flushPendingSerialization = vi.fn()
    const clearAnnotationTarget = vi.fn()
    const config = createRichMarkdownEditorConfig(
      createConfigParams({ clearAnnotationTarget, flushPendingSerialization })
    )

    config.onBlur?.({} as never)

    expect(setMarkdownEditorFocused).toHaveBeenCalledWith(false)
    expect(clearAnnotationTarget).toHaveBeenCalledOnce()
    expect(flushPendingSerialization).toHaveBeenCalledOnce()
  })
})

describe('rich Markdown DOM paste admission', () => {
  const editors: Editor[] = []

  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy())
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function pasteEditor() {
    vi.useFakeTimers()
    const saveClipboardImageAsTempFile = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { setMarkdownEditorFocused: vi.fn(), saveClipboardImageAsTempFile } }
    })
    const params = createConfigParams({ content: 'hello world\n\nother paragraph' })
    const config = createRichMarkdownEditorConfig(params)
    const editor = new Editor({
      ...config,
      extensions: createRichMarkdownExtensions({
        codec: params.codec,
        htmlSuperscriptLinks: true,
        htmlSuperscriptLinkContext: params.htmlSuperscriptLinkContext
      })
    })
    params.editorRef.current = editor
    document.body.append(editor.view.dom)
    editor.view.dom.focus()
    editor.commands.setTextSelection({ from: 7, to: 12 })
    editors.push(editor)
    const parser = DocumentParser.fromSchema(editor.schema)
    const parseSlice = vi.spyOn(parser, 'parseSlice')
    editor.setOptions({ editorProps: { ...config.editorProps, clipboardParser: parser } })
    return { editor, parseSlice, saveClipboardImageAsTempFile }
  }

  function paste(editor: Editor, text: string, html = ''): ClipboardEvent {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    if (html) {
      clipboardData.setData('text/html', html)
    }
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(event)
    return event
  }

  it('chunks a large HTML paste without building a clipboard slice', async () => {
    const { editor, parseSlice } = pasteEditor()
    const text = 'large paste '.repeat(6_000)

    expect(paste(editor, text, `<p>${text}</p>`).defaultPrevented).toBe(true)
    await vi.runAllTimersAsync()

    expect(editor.state.doc.firstChild?.textContent).toBe(`hello ${text}`)
    expect(editor.state.doc.child(1).textContent).toBe('other paragraph')
    expect(parseSlice).not.toHaveBeenCalled()
  })

  it('keeps source-rich clipboard content on the parsed preservation route', async () => {
    const { editor } = pasteEditor()
    const text = 'source '.repeat(10_000)
    const source = '<sup><a href="https://example.com">[1]</a></sup>'
    const document = editor.schema.node('doc', null, [
      editor.schema.node('paragraph', null, [
        editor.schema.text(text),
        editor.schema.node('richMarkdownHtmlSuperscriptLink', {
          source,
          href: 'https://example.com',
          label: '[1]',
          title: null
        })
      ])
    ])
    const html = editor.view.serializeForClipboard(document.slice(1, document.content.size - 1)).dom
      .innerHTML
    paste(editor, `${text}[1]`, html)
    await vi.runAllTimersAsync()

    expect(editor.getMarkdown()).toContain(source)
    expect(editor.state.doc.firstChild?.textContent).toBe(`hello ${text}`)
    let citations = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'richMarkdownHtmlSuperscriptLink') {
        citations += 1
      }
    })
    expect(citations).toBe(1)
  })

  it('keeps image import ahead of a large text fallback', async () => {
    const { editor, parseSlice, saveClipboardImageAsTempFile } = pasteEditor()
    const before = editor.state.doc
    const clipboardData = new DataTransfer()
    clipboardData.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
    clipboardData.setData('text/plain', 'fallback '.repeat(10_000))
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(event)
    await vi.runAllTimersAsync()

    expect(event.defaultPrevented).toBe(true)
    expect(saveClipboardImageAsTempFile.mock.calls.length).toBe(1)
    expect(editor.state.doc.eq(before)).toBe(true)
    expect(parseSlice).not.toHaveBeenCalled()
  })
})

describe('rich Markdown DOM click routing', () => {
  let editor: Editor

  beforeEach(() => {
    vi.mocked(handleRichMarkdownEditorClick).mockReset().mockReturnValue(true)
    editor = new Editor({ extensions: [StarterKit], content: '<p>example</p>' })
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
  })
  afterEach(() => editor.destroy())

  function click(event: PointerEvent, isMac = true): boolean | void {
    const config = createRichMarkdownEditorConfig(createConfigParams({ isMac }))
    return config.editorProps?.handleDOMEvents?.click?.call(editor.view, editor.view, event)
  }

  it.each([true, false])('routes the primary Shift+platform modifier click (Mac: %s)', (isMac) => {
    const event = new PointerEvent('click', {
      metaKey: isMac,
      ctrlKey: !isMac,
      shiftKey: true,
      cancelable: true
    })
    expect(click(event, isMac)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(handleRichMarkdownEditorClick).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event, pos: 2, view: editor.view })
    )
  })

  it.each([
    { shiftKey: true },
    { metaKey: true },
    { ctrlKey: true, shiftKey: true },
    { metaKey: true, shiftKey: true, button: 1 },
    { metaKey: true, shiftKey: true, button: 2 }
  ])('leaves neighboring gestures alone: %j', (modifiers) => {
    const event = new PointerEvent('click', { ...modifiers, cancelable: true })
    expect(click(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(handleRichMarkdownEditorClick).not.toHaveBeenCalled()
  })

  it('avoids opening twice if Shift is pressed between mouse down and mouse up', () => {
    const config = createRichMarkdownEditorConfig(createConfigParams({ isMac: true }))
    const event = new MouseEvent('mouseup', { metaKey: true, shiftKey: true })
    expect(config.editorProps?.handleClick?.call(editor.view, editor.view, 2, event)).toBe(false)
    expect(handleRichMarkdownEditorClick).not.toHaveBeenCalled()
  })

  it('leaves an already handled click alone', () => {
    const event = new PointerEvent('click', { metaKey: true, shiftKey: true, cancelable: true })
    event.preventDefault()
    expect(click(event)).toBe(false)
    expect(handleRichMarkdownEditorClick).not.toHaveBeenCalled()
  })

  it('keeps selection behavior when no link handles the click', () => {
    vi.mocked(handleRichMarkdownEditorClick).mockReturnValue(false)
    const event = new PointerEvent('click', { metaKey: true, shiftKey: true, cancelable: true })
    expect(click(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('rich Markdown slash commands in code', () => {
  const editors: Editor[] = []

  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy())
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function slashEditor(content: string) {
    vi.useFakeTimers()
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { setMarkdownEditorFocused: vi.fn() } }
    })
    const root = document.createElement('div')
    document.body.append(root)
    const params = createConfigParams({ content, rootRef: ref(root) })
    params.filteredSlashCommandsRef.current = slashCommands
    params.setDocLinkMenu = (next) => {
      params.docLinkMenuRef.current =
        typeof next === 'function' ? next(params.docLinkMenuRef.current) : next
    }
    params.setSlashMenu = (next) => {
      params.slashMenuRef.current =
        typeof next === 'function' ? next(params.slashMenuRef.current) : next
    }
    const editor = new Editor({
      ...createRichMarkdownEditorConfig(params),
      extensions: createRichMarkdownExtensions({ codec: params.codec })
    })
    params.editorRef.current = editor
    root.append(editor.view.dom)
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: 0, bottom: 20, left: 0, right: 0 })
    editors.push(editor)
    return { editor, params }
  }

  function enter(editor: Editor) {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    })
    editor.view.dom.dispatchEvent(event)
  }

  it('keeps a literal slash and Enter inside a fenced code block', () => {
    const { editor, params } = slashEditor('```sh\n\n```')
    editor.commands.setTextSelection(1)
    editor.view.dispatch(editor.state.tr.insertText('/'))

    const menuWasOpen = params.slashMenuRef.current !== null
    enter(editor)

    expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(editor.state.doc.firstChild?.textContent).toBe('/\n')
    expect(menuWasOpen).toBe(false)
  })

  it('does not offer block conversion for a slash in inline code', () => {
    const { editor, params } = slashEditor('')
    editor.commands.setTextSelection(1)
    editor.commands.toggleCode()
    editor.view.dispatch(editor.state.tr.insertText('/'))

    const menuWasOpen = params.slashMenuRef.current !== null
    enter(editor)

    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(editor.state.doc.firstChild?.textContent).toBe('/')
    expect(editor.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      'code'
    ])
    expect(menuWasOpen).toBe(false)
  })

  it('keeps an inline-code document-link trigger literal', () => {
    const { editor, params } = slashEditor('')
    editor.commands.setTextSelection(1)
    editor.commands.toggleCode()
    editor.view.dispatch(editor.state.tr.insertText('[['))

    expect(editor.state.doc.firstChild?.textContent).toBe('[[')
    expect(editor.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      'code'
    ])
    expect(params.docLinkMenuRef.current).toBeNull()
  })

  it('still offers and commits a block command from ordinary prose', () => {
    const { editor, params } = slashEditor('')
    editor.commands.setTextSelection(1)
    editor.view.dispatch(editor.state.tr.insertText('/'))

    expect(params.slashMenuRef.current?.query).toBe('')
    enter(editor)

    expect(editor.state.doc.firstChild?.type.name).toBe('heading')
    expect(editor.state.doc.firstChild?.attrs.level).toBe(1)
    expect(editor.state.doc.firstChild?.textContent).toBe('')
  })
})
