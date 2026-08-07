import { describe, expect, it, vi } from 'vitest'
import type { MarkupShape } from './markup-drawing-model'
import {
  buildMarkupElementResolutionScript,
  markupShapeTargetPoint,
  markupShapeToLog,
  resolveMarkupShapeElements
} from './markup-element-resolution'

function makeWebview(result: unknown): { executeJavaScript: ReturnType<typeof vi.fn> } {
  return { executeJavaScript: vi.fn().mockResolvedValue(result) }
}

const arrow: MarkupShape = {
  kind: 'arrow',
  id: 'a',
  color: '#f00',
  from: { x: 10, y: 20 },
  to: { x: 30, y: 40 },
  width: 4
}

describe('markupShapeTargetPoint', () => {
  it('uses the arrow tip as the pointed-to point', () => {
    expect(markupShapeTargetPoint(arrow)).toEqual({ x: 30, y: 40 })
  })

  it('uses the box center for rect and ellipse', () => {
    const rect: MarkupShape = {
      kind: 'rect',
      id: 'r',
      color: '#f00',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 200 },
      width: 4
    }
    expect(markupShapeTargetPoint(rect)).toEqual({ x: 50, y: 100 })
  })

  it('uses the text anchor', () => {
    const text: MarkupShape = {
      kind: 'text',
      id: 't',
      color: '#f00',
      at: { x: 5, y: 6 },
      text: 'hi',
      fontSize: 18
    }
    expect(markupShapeTargetPoint(text)).toEqual({ x: 5, y: 6 })
  })

  it('uses the last pen point', () => {
    const pen: MarkupShape = {
      kind: 'pen',
      id: 'p',
      color: '#f00',
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 }
      ],
      width: 4
    }
    expect(markupShapeTargetPoint(pen)).toEqual({ x: 3, y: 4 })
  })
})

describe('markupShapeToLog', () => {
  it('keeps arrow geometry', () => {
    expect(markupShapeToLog(arrow)).toEqual({
      kind: 'arrow',
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 }
    })
  })

  it('keeps text content', () => {
    expect(
      markupShapeToLog({
        kind: 'text',
        id: 't',
        color: '#f00',
        at: { x: 5, y: 6 },
        text: 'hi',
        fontSize: 18
      })
    ).toEqual({
      kind: 'text',
      at: { x: 5, y: 6 },
      text: 'hi'
    })
  })

  it('reduces a pen to its point count', () => {
    expect(
      markupShapeToLog({
        kind: 'pen',
        id: 'p',
        color: '#f00',
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 }
        ],
        width: 4
      })
    ).toEqual({ kind: 'pen', pointCount: 2 })
  })
})

describe('buildMarkupElementResolutionScript', () => {
  it('embeds the points and probes elementFromPoint', () => {
    const script = buildMarkupElementResolutionScript([{ x: 30, y: 40 }])
    expect(script).toContain('document.elementFromPoint(p.x, p.y)')
    expect(script).toContain('"x":30')
    expect(script).toContain('"y":40')
  })
})

describe('resolveMarkupShapeElements', () => {
  it('attaches resolved elements to the matching shapes', async () => {
    const webview = makeWebview([
      { tagName: 'button', selector: 'button#submit', accessibleName: null, textSnippet: 'Kaydet' }
    ])
    const logs = await resolveMarkupShapeElements(webview as never, [arrow])
    expect(logs[0]?.element).toEqual({
      tagName: 'button',
      selector: 'button#submit',
      accessibleName: null,
      textSnippet: 'Kaydet'
    })
    expect(webview.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('falls back to geometry-only logs when the query fails', async () => {
    const webview = {
      executeJavaScript: vi.fn().mockRejectedValue(new Error('page gone'))
    }
    const logs = await resolveMarkupShapeElements(webview as never, [arrow])
    expect(logs[0]?.element).toBeNull()
    expect(logs[0]?.kind).toBe('arrow')
  })

  it('marks shapes with no hit as null elements', async () => {
    const webview = makeWebview([null])
    const logs = await resolveMarkupShapeElements(webview as never, [arrow])
    expect(logs[0]?.element).toBeNull()
  })

  it('normalizes hostile guest element fields to bounded single-line text', async () => {
    const webview = makeWebview([
      {
        tagName: 'button',
        selector: 'button#x',
        accessibleName: `a\nmarkdown *injection*\n${'x'.repeat(200)}`,
        textSnippet: '  spaced\n  text  '
      }
    ])
    const logs = await resolveMarkupShapeElements(webview as never, [arrow])
    const element = logs[0]?.element
    expect(element?.accessibleName?.includes('\n')).toBe(false)
    expect(element?.accessibleName?.length).toBeLessThanOrEqual(80)
    expect(element?.accessibleName).toContain('a markdown *injection*')
    expect(element?.textSnippet).toBe('spaced text')
  })

  it('drops malformed element payloads', async () => {
    const webview = makeWebview([{ tagName: 42 }, { selector: 'div.x' }])
    const logs = await resolveMarkupShapeElements(webview as never, [arrow, arrow])
    expect(logs[0]?.element).toBeNull()
    expect(logs[1]?.element).toBeNull()
  })
})
