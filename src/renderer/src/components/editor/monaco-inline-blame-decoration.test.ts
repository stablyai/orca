// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import type { editor } from 'monaco-editor'
import {
  buildInlineBlameLabel,
  InlineBlameWidget,
  inlineBlamePosition,
  withMonospaceFallback
} from './monaco-inline-blame-decoration'

function makeModel(lineCount: number, maxColumn = 40): editor.ITextModel {
  return {
    getLineCount: () => lineCount,
    getLineMaxColumn: () => maxColumn
  } as unknown as editor.ITextModel
}

function makeHost(
  fontInfo: { lineHeight: number; fontFamily: string; fontSize: number } | null = {
    lineHeight: 22,
    fontFamily: 'Menlo',
    fontSize: 13
  }
): {
  host: editor.IStandaloneCodeEditor
  addContentWidget: ReturnType<typeof vi.fn>
  removeContentWidget: ReturnType<typeof vi.fn>
  layoutContentWidget: ReturnType<typeof vi.fn>
} {
  const addContentWidget = vi.fn()
  const removeContentWidget = vi.fn()
  const layoutContentWidget = vi.fn()
  return {
    host: {
      addContentWidget,
      removeContentWidget,
      layoutContentWidget,
      getOption: () => fontInfo
    } as unknown as editor.IStandaloneCodeEditor,
    addContentWidget,
    removeContentWidget,
    layoutContentWidget
  }
}

describe('buildInlineBlameLabel', () => {
  it('renders author, relative date, and summary', () => {
    expect(
      buildInlineBlameLabel({
        author: 'Neil',
        relativeDate: '3 months ago',
        summary: 'docs: localize README',
        isUncommitted: false,
        uncommittedLabel: 'Uncommitted changes'
      })
    ).toBe('Neil, 3 months ago · docs: localize README')
  })

  it('uses the uncommitted label instead of authorship', () => {
    expect(
      buildInlineBlameLabel({
        author: 'Not Committed Yet',
        relativeDate: 'now',
        summary: 'whatever',
        isUncommitted: true,
        uncommittedLabel: 'Uncommitted changes'
      })
    ).toBe('Uncommitted changes')
  })

  it('drops empty pieces instead of leaving separators behind', () => {
    expect(
      buildInlineBlameLabel({
        author: 'Neil',
        relativeDate: '',
        summary: '',
        isUncommitted: false,
        uncommittedLabel: 'Uncommitted changes'
      })
    ).toBe('Neil')
  })

  it('truncates a long summary so it cannot run far past the code', () => {
    const label = buildInlineBlameLabel({
      author: 'Neil',
      relativeDate: 'now',
      summary: 'x'.repeat(200),
      isUncommitted: false,
      uncommittedLabel: 'Uncommitted changes'
    })
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThan(80)
  })
})

describe('withMonospaceFallback', () => {
  it('appends the generic so an unresolved name cannot land on the UI font', () => {
    expect(withMonospaceFallback('SF Mono')).toBe('SF Mono, monospace')
  })

  it('leaves an existing generic alone instead of repeating it', () => {
    expect(withMonospaceFallback("Menlo, 'Courier New', monospace")).toBe(
      "Menlo, 'Courier New', monospace"
    )
  })

  it('normalizes spacing in a multi-family stack', () => {
    expect(withMonospaceFallback('Menlo,  Consolas')).toBe('Menlo, Consolas, monospace')
  })
})

describe('inlineBlamePosition', () => {
  it('anchors past the last character of the line', () => {
    expect(inlineBlamePosition(makeModel(10, 25), 4)).toEqual({ lineNumber: 4, column: 25 })
  })

  it('returns null for a line outside the model', () => {
    // Why: a blame response can land after the buffer shrank; positioning on a
    // line that no longer exists throws inside Monaco.
    expect(inlineBlamePosition(makeModel(3), 9)).toBeNull()
    expect(inlineBlamePosition(makeModel(3), 0)).toBeNull()
    expect(inlineBlamePosition(makeModel(3), 1.5)).toBeNull()
  })
})

describe('InlineBlameWidget', () => {
  it('adds itself once and then only re-lays out', () => {
    const { host, addContentWidget, layoutContentWidget } = makeHost()
    const widget = new InlineBlameWidget(host)

    widget.show('Neil, now', { lineNumber: 2, column: 10 })
    widget.show('Neil, later', { lineNumber: 3, column: 12 })

    expect(addContentWidget).toHaveBeenCalledTimes(1)
    expect(layoutContentWidget).toHaveBeenCalledTimes(1)
    expect(widget.getDomNode().textContent).toBe('Neil, later')
    expect(widget.getPosition()?.position).toEqual({ lineNumber: 3, column: 12 })
  })

  it('renders at the exact position so it cannot reflow the line', () => {
    const { host } = makeHost()
    const widget = new InlineBlameWidget(host)
    widget.show('Neil, now', { lineNumber: 2, column: 10 })

    // EXACT; ABOVE/BELOW would move the annotation off the row it describes.
    expect(widget.getPosition()?.preference).toEqual([
      monaco.editor.ContentWidgetPositionPreference.EXACT
    ])
  })

  it('sizes itself to the editor line height so the text keeps the code baseline', () => {
    // Why: a content widget is sized by its own content, so without this the
    // annotation sat centred in a box of a different height and drifted off the
    // line it annotates. The box keeps the full line height even though the
    // text is smaller, so the annotation still occupies exactly one row.
    const { host } = makeHost({ lineHeight: 22, fontFamily: 'Menlo', fontSize: 13 })
    const widget = new InlineBlameWidget(host)

    widget.show('Neil, now', { lineNumber: 2, column: 10 })

    const style = widget.getDomNode().style
    expect(style.height).toBe('22px')
    expect(style.lineHeight).toBe('22px')
  })

  it('renders in the editor font, one notch smaller than the code', () => {
    const { host } = makeHost({ lineHeight: 22, fontFamily: 'Menlo', fontSize: 13 })
    const widget = new InlineBlameWidget(host)

    widget.show('Neil, now', { lineNumber: 2, column: 10 })

    // Same family as the code — an annotation in a different typeface reads as
    // foreign content — at 90% so it stays secondary to the source.
    expect(widget.getDomNode().style.fontFamily).toBe('Menlo, monospace')
    expect(widget.getDomNode().style.fontSize).toBe('11.7px')
  })

  it('keeps a single-name editor font from falling back to the UI font', () => {
    // Why: `SF Mono` is the macOS default here and carries no fallback of its
    // own; in a plain widget div an unresolved name lands on the proportional
    // UI font, which is exactly what stops it looking like code.
    const { host } = makeHost({ lineHeight: 22, fontFamily: 'SF Mono', fontSize: 13 })
    const widget = new InlineBlameWidget(host)

    widget.show('Neil, now', { lineNumber: 2, column: 10 })

    expect(widget.getDomNode().style.fontFamily).toBe('"SF Mono", monospace')
  })

  it('tracks the editor font size when it changes', () => {
    const { host } = makeHost({ lineHeight: 30, fontFamily: 'Menlo', fontSize: 20 })
    const widget = new InlineBlameWidget(host)

    widget.show('Neil, now', { lineNumber: 2, column: 10 })

    expect(widget.getDomNode().style.fontSize).toBe('18px')
  })

  it('renders without metrics when the host cannot report font info', () => {
    const { host, addContentWidget } = makeHost(null)
    const widget = new InlineBlameWidget(host)

    widget.show('Neil, now', { lineNumber: 2, column: 10 })

    expect(addContentWidget).toHaveBeenCalledTimes(1)
    expect(widget.getDomNode().style.height).toBe('')
  })

  it('reports no position while hidden so Monaco parks it off screen', () => {
    const { host, removeContentWidget } = makeHost()
    const widget = new InlineBlameWidget(host)
    widget.show('Neil, now', { lineNumber: 2, column: 10 })

    widget.hide()

    expect(removeContentWidget).toHaveBeenCalledTimes(1)
    expect(widget.getPosition()).toBeNull()
  })

  it('does not remove a widget it never added', () => {
    const { host, removeContentWidget } = makeHost()
    new InlineBlameWidget(host).hide()

    expect(removeContentWidget).not.toHaveBeenCalled()
  })

  it('re-adds after being hidden', () => {
    const { host, addContentWidget } = makeHost()
    const widget = new InlineBlameWidget(host)

    widget.show('a', { lineNumber: 1, column: 2 })
    widget.hide()
    widget.show('b', { lineNumber: 1, column: 2 })

    expect(addContentWidget).toHaveBeenCalledTimes(2)
  })
})
