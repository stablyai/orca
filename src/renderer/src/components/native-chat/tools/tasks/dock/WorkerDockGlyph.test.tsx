// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { WorkerDockGlyph } from './WorkerDockGlyph'

afterEach(cleanup)

// The stylesheet as written: the test runner stubs CSS imports, and happy-dom computes no media queries.
const css = readFileSync(join(import.meta.dirname, '../../../../../assets/main.css'), 'utf8')
const rule = (opening: string, end = '}'): string => {
  const start = css.indexOf(opening)
  expect(start).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf(end, start))
}

function renderGrid() {
  const { container } = render(<WorkerDockGlyph glyph="running" chip />)
  const grid = container.querySelector<HTMLElement>('[data-worker-dock-dot-grid]')
  expect(grid).not.toBeNull()
  return { grid: grid!, cells: [...grid!.children] as HTMLElement[] }
}

it('lights the chip running grid along its diagonals, top-left first', () => {
  const { cells } = renderGrid()
  // 2s × (row + column) / 7.5 for a 3×3 grid.
  expect(cells.map((cell) => cell.style.animationDelay)).toEqual([
    '0.0ms',
    '266.7ms',
    '533.3ms',
    '266.7ms',
    '533.3ms',
    '800.0ms',
    '533.3ms',
    '800.0ms',
    '1066.7ms'
  ])
})

it('anchors all nine cells to the shared clock as soon as the first cell starts', () => {
  const { grid, cells } = renderGrid()
  // Started at mount (document time 1234); the later cells are still inside their delay.
  const wave = cells.map(() => ({ animationName: 'worker-dock-dot-wave', startTime: 1234 }))
  const other = { animationName: 'agent-spinner-rotate', startTime: 1234 }
  grid.getAnimations = (() => [...wave, other]) as unknown as Element['getAnimations']
  cells.forEach((cell, index) => {
    cell.getAnimations = (() => [wave[index]]) as unknown as Element['getAnimations']
  })
  fireEvent.animationStart(cells[0], { animationName: 'worker-dock-dot-wave' })
  expect(wave.map((animation) => animation.startTime)).toEqual(Array(9).fill(0))
  expect(other.startTime).toBe(1234)
})

it('animates opacity only, drops the wave offscreen and holds every cell lit under reduced motion', () => {
  expect(rule('@keyframes worker-dock-dot-wave', '\n}').replace(/opacity/g, '')).not.toMatch(
    /[a-z-]+:/
  )
  expect(rule('.worker-dock-dot-grid[data-animation-offscreen] > * {')).toMatch(/animation: none;/)
  expect(rule('.worker-dock-dot-grid > * {')).toMatch(/opacity: 0\.9;/)
  expect(
    rule('@media (prefers-reduced-motion: reduce) {\n  .agent-working-spinner', '\n}')
  ).toMatch(/\.worker-dock-dot-grid > \* \{\s*animation: none;/)
})
