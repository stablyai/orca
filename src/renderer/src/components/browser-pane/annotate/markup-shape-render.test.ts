import { describe, expect, it } from 'vitest'
import { textInkBox } from './markup-shape-render'

// Record the context subset drawShape uses without requiring a real canvas.
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
