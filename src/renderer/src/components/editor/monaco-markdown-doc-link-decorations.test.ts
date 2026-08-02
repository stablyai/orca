import type { editor } from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMarkdownDocLinkDecorationController,
  getMarkdownDocLinkDecorationRanges,
  MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS
} from './monaco-markdown-doc-link-decorations'

describe('getMarkdownDocLinkDecorationRanges', () => {
  it('returns Monaco ranges for valid doc links', () => {
    expect(getMarkdownDocLinkDecorationRanges('link to [[other.md]]')).toEqual([
      {
        startLineNumber: 1,
        startColumn: 9,
        endLineNumber: 1,
        endColumn: 21
      }
    ])
  })

  it('returns ranges for aliased doc links', () => {
    expect(getMarkdownDocLinkDecorationRanges('[[doc|Label]]')).toEqual([
      {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 14
      }
    ])
  })

  it('ignores unsupported doc link syntax', () => {
    expect(getMarkdownDocLinkDecorationRanges('[[doc|]] [[bad [target]] [[]]')).toEqual([])
  })

  it('ignores doc links inside inline and fenced code', () => {
    expect(
      getMarkdownDocLinkDecorationRanges('`[[inline]]`\n\n```md\n[[fenced]]\n```\n[[real]]')
    ).toEqual([
      {
        startLineNumber: 6,
        startColumn: 1,
        endLineNumber: 6,
        endColumn: 9
      }
    ])
  })

  it('supports CRLF markdown without splitting the full document', () => {
    const split = vi.spyOn(String.prototype, 'split')

    expect(getMarkdownDocLinkDecorationRanges('intro\r\n[[other.md]]\r\n')).toEqual([
      {
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 13
      }
    ])
    expect(split).not.toHaveBeenCalled()
  })

  it('scans pasted markdown without allocating one array entry per line', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const content = [
      '# Notes',
      ...Array.from({ length: 10_000 }, () => 'plain'),
      '[[target.md]]'
    ].join('\n')

    const ranges = getMarkdownDocLinkDecorationRanges(content)

    expect(ranges).toEqual([
      {
        startLineNumber: 10_002,
        startColumn: 1,
        endLineNumber: 10_002,
        endColumn: 14
      }
    ])
    expect(split).not.toHaveBeenCalled()
  })
})

describe('createMarkdownDocLinkDecorationController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces full-model decoration rebuilds during rapid content changes', () => {
    vi.useFakeTimers()

    let modelValue = '[[initial.md]]'
    let contentListener = (): void => {}
    const set = vi.fn()
    const clear = vi.fn()
    const dispose = vi.fn()

    const editorInstance = {
      createDecorationsCollection: () => ({ set, clear }),
      getModel: () => ({ getValue: () => modelValue }),
      onDidChangeModelContent: (listener: () => void) => {
        contentListener = listener
        return { dispose }
      }
    } as unknown as editor.IStandaloneCodeEditor

    const controller = createMarkdownDocLinkDecorationController(editorInstance, () => 'markdown')
    expect(set).toHaveBeenCalledTimes(1)

    set.mockClear()
    modelValue = '[[first.md]]'
    contentListener?.()
    vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS - 1)
    modelValue = '[[second.md]]'
    contentListener?.()
    modelValue = '[[final.md]]'
    contentListener?.()

    expect(set).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS - 1)
    expect(set).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]?.[0]).toEqual([
      {
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 13
        },
        options: {
          inlineClassName: 'monaco-markdown-doc-link',
          stickiness: 1
        }
      }
    ])

    controller.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('cancels pending decoration rebuilds on dispose', () => {
    vi.useFakeTimers()

    let contentListener = (): void => {}
    const set = vi.fn()
    const clear = vi.fn()

    const editorInstance = {
      createDecorationsCollection: () => ({ set, clear }),
      getModel: () => ({ getValue: () => '[[initial.md]]' }),
      onDidChangeModelContent: (listener: () => void) => {
        contentListener = listener
        return { dispose: vi.fn() }
      }
    } as unknown as editor.IStandaloneCodeEditor

    const controller = createMarkdownDocLinkDecorationController(editorInstance, () => 'markdown')
    set.mockClear()

    contentListener?.()
    controller.dispose()
    vi.advanceTimersByTime(MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS)

    expect(set).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
