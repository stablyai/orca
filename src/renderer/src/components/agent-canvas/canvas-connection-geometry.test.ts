import { expect, it } from 'vitest'
import { canvasConnectionGeometry, canvasConnectionPath } from './canvas-connection-geometry'

it('separates opposite directions so both connections remain clickable', () => {
  const a = { position: { x: 0, y: 0 }, width: 320, height: 240 }
  const b = { ...a, position: { x: 400, y: 0 } }
  const forward = canvasConnectionPath(a, b, true)
  const backward = canvasConnectionPath(b, a, true)
  expect(forward.y).not.toBe(backward.y)
  expect(forward.path).not.toBe(backward.path)
  expect(backward.path).toContain('Q')
  expect(backward.y).toBeLessThan(0)
})

it('anchors connections on the output and input dots, including reverse links', () => {
  const source = { position: { x: 100, y: 100 }, width: 320, height: 240 }
  const target = { position: { x: 20, y: 364 }, width: 480, height: 360 }
  expect(canvasConnectionGeometry(source, target)).toEqual({
    sourceX: 420,
    sourceY: 220,
    targetX: 20,
    targetY: 544
  })
  expect(canvasConnectionGeometry(target, source)).toEqual({
    sourceX: 500,
    sourceY: 544,
    targetX: 100,
    targetY: 220
  })
  const right = { ...source, position: { x: 500, y: 100 } }
  expect(canvasConnectionGeometry(source, right)).toEqual({
    sourceX: 420,
    sourceY: 220,
    targetX: 500,
    targetY: 220
  })
})
