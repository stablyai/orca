import { describe, expect, it } from 'vitest'
import { drawShape, textInkBox } from './markup-shape-render'
import { HIGHLIGHT_ALPHA, type MarkupShape } from './markup-drawing-model'

// Minimal recording stand-in for CanvasRenderingContext2D — drawShape only uses
// this subset, so we can assert the dispatch without a real canvas.
function makeRecordingCtx() {
  const calls: { method: string; args: unknown[] }[] = []
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
    }
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    ellipse: record('ellipse'),
    stroke: record('stroke'),
    fill: record('fill'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    // Records the style in force when measuring, and returns fixed ink metrics.
    measureText: () => {
      calls.push({ method: 'measureText', args: [ctx.font, ctx.textBaseline] })
      return {
        actualBoundingBoxLeft: 1,
        actualBoundingBoxRight: 40,
        actualBoundingBoxAscent: -2,
        actualBoundingBoxDescent: 20
      }
    },
    lineCap: '',
    lineJoin: '',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textBaseline: ''
  }
  const methods = (name: string) => calls.filter((c) => c.method === name)
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, methods }
}

describe('drawShape dispatch', () => {
  it('strokes a multi-point pen as a polyline', () => {
    const { ctx, methods } = makeRecordingCtx()
    const shape: MarkupShape = {
      id: 'p',
      kind: 'pen',
      color: '#ef4444',
      width: 4,
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 9, y: 1 }
      ]
    }
    drawShape(ctx, shape)
    expect(methods('moveTo')).toHaveLength(1)
    expect(methods('lineTo')).toHaveLength(2)
    expect(methods('stroke')).toHaveLength(1)
  })

  it('draws a dot for a single-point pen', () => {
    const { ctx, methods } = makeRecordingCtx()
    drawShape(ctx, { id: 'p', kind: 'pen', color: '#fff', width: 4, points: [{ x: 3, y: 3 }] })
    expect(methods('arc')).toHaveLength(1)
    expect(methods('fill')).toHaveLength(1)
  })

  it('applies translucent alpha for highlights', () => {
    const { ctx } = makeRecordingCtx()
    drawShape(ctx, {
      id: 'h',
      kind: 'highlight',
      color: '#eab308',
      width: 4,
      points: [
        { x: 0, y: 0 },
        { x: 8, y: 0 }
      ]
    })
    expect(ctx.globalAlpha).toBe(HIGHLIGHT_ALPHA)
  })

  it('draws an arrow as a shaft plus a head', () => {
    const { ctx, methods } = makeRecordingCtx()
    drawShape(ctx, {
      id: 'a',
      kind: 'arrow',
      color: '#fff',
      width: 4,
      from: { x: 0, y: 0 },
      to: { x: 20, y: 0 }
    })
    // shaft (moveTo+lineTo) + head (moveTo+lineTo+lineTo)
    expect(methods('moveTo').length).toBeGreaterThanOrEqual(2)
    expect(methods('stroke').length).toBeGreaterThanOrEqual(2)
  })

  it('uses strokeRect for rectangles', () => {
    const { ctx, methods } = makeRecordingCtx()
    drawShape(ctx, {
      id: 'r',
      kind: 'rect',
      color: '#fff',
      width: 2,
      from: { x: 10, y: 10 },
      to: { x: 4, y: 30 }
    })
    expect(methods('strokeRect')).toHaveLength(1)
    expect(methods('strokeRect')[0].args).toEqual([4, 10, 6, 20])
  })

  it('uses ellipse for ovals', () => {
    const { ctx, methods } = makeRecordingCtx()
    drawShape(ctx, {
      id: 'e',
      kind: 'ellipse',
      color: '#fff',
      width: 2,
      from: { x: 0, y: 0 },
      to: { x: 20, y: 10 }
    })
    expect(methods('ellipse')).toHaveLength(1)
    expect(methods('ellipse')[0].args.slice(0, 4)).toEqual([10, 5, 10, 5])
  })

  it('renders single-line text with a halo (stroke behind fill)', () => {
    const { ctx, methods } = makeRecordingCtx()
    drawShape(ctx, {
      id: 't',
      kind: 'text',
      color: '#fff',
      at: { x: 5, y: 5 },
      text: 'fix this',
      fontSize: 18
    })
    expect(methods('strokeText')).toHaveLength(1)
    expect(methods('fillText')).toHaveLength(1)
    expect(methods('fillText')[0].args[0]).toBe('fix this')
  })

  it('save/restore brackets every shape so state never leaks', () => {
    const { ctx, methods } = makeRecordingCtx()
    drawShape(ctx, {
      id: 'r',
      kind: 'rect',
      color: '#fff',
      width: 2,
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 }
    })
    expect(methods('save')).toHaveLength(1)
    expect(methods('restore')).toHaveLength(1)
  })
})

describe('textInkBox', () => {
  it('covers the measured glyphs plus the halo, measured in the style text is drawn with', () => {
    const { ctx, methods } = makeRecordingCtx()

    const box = textInkBox(ctx, {
      id: 't',
      kind: 'text',
      color: '#111827',
      at: { x: 100, y: 200 },
      text: 'gy',
      fontSize: 18
    })

    const [font, textBaseline] = methods('measureText')[0].args
    expect(font).toContain('18px')
    expect(textBaseline).toBe('top')
    // The halo is 3px wide at 18px type, so it adds 1.5px on every side.
    expect(box).toEqual({ x: 97.5, y: 200.5, width: 44, height: 21 })
  })
})
