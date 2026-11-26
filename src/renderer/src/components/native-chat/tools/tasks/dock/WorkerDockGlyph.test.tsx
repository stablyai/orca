// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => [] as Element[])
vi.mock('@/lib/window-activity/offscreen-animation-pause', () => ({
  observeOffscreenAnimation: (element: Element | null) => {
    if (element) {
      observed.push(element)
    }
    return () => {}
  }
}))

import { WorkerDockGlyph } from './WorkerDockGlyph'
import { WorkerDockPill } from './WorkerDockPill'

afterEach(() => {
  cleanup()
  observed.length = 0
})

// The stylesheet as written: the test runner stubs CSS imports, and happy-dom computes no media queries.
const css = readFileSync(join(import.meta.dirname, '../../../../../assets/main.css'), 'utf8')
const block = (selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start) + 1)
}
const section = (opening: string): string => {
  const start = css.indexOf(opening)
  expect(start).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('\n}', start))
}

describe('WorkerDockGlyph', () => {
  it('draws the folded chip running mark as a 3×3 grid lit along diagonals', () => {
    const { container } = render(<WorkerDockGlyph glyph="running" still />)
    const grid = container.querySelector('[data-worker-dock-dot-grid]')
    expect(grid).not.toBeNull()
    expect(grid).toHaveClass('worker-dock-dot-grid', 'grid-cols-[repeat(3,2px)]', 'gap-px')
    const cells = [...grid!.children] as HTMLElement[]
    expect(cells).toHaveLength(9)
    for (const cell of cells) {
      expect(cell).toHaveClass('size-0.5', 'rounded-[1px]', 'bg-agent-working')
    }
    // Delay = 2s × (row + column) / 7.5, top-left first.
    expect(cells.map((cell) => cell.style.animationDelay)).toEqual(
      [0, 1, 2, 1, 2, 3, 2, 3, 4].map((d) => `${((2000 * d) / 7.5).toFixed(1)}ms`)
    )
    // Decorative, and watched so it stops while offscreen.
    expect(container.querySelector('[data-worker-dock-glyph="running"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
    expect(observed).toEqual([grid])
  })

  it('animates opacity only, drops the wave offscreen, and holds every cell lit under reduced motion', () => {
    const keyframes = section('@keyframes worker-dock-dot-wave')
    expect(keyframes).toMatch(
      /0%,\s*60%,\s*100% \{\s*opacity: 0\.3;\s*\}\s*25% \{\s*opacity: 0\.9;/
    )
    expect(keyframes.replace(/opacity/g, '')).not.toMatch(/[a-z-]+:/)
    expect(block('.worker-dock-dot-grid > *')).toMatch(/opacity: 0\.9;/)
    expect(block('.worker-dock-dot-grid > *')).toMatch(
      /animation: worker-dock-dot-wave 2s ease-in-out infinite both;/
    )
    expect(block('.worker-dock-dot-grid[data-animation-offscreen] > *')).toMatch(/animation: none;/)
    expect(section('@media (prefers-reduced-motion: reduce) {\n  .agent-working-spinner')).toMatch(
      /\.worker-dock-dot-grid > \* \{\s*animation: none;/
    )
  })

  it.each([
    ['failed', 'bg-destructive'],
    ['done', 'bg-status-success'],
    ['queued', 'border-muted-foreground']
  ] as const)('keeps the %s dot unchanged', (glyph, paint) => {
    const { container } = render(<WorkerDockGlyph glyph={glyph} still />)
    const mark = container.querySelector(`[data-worker-dock-glyph="${glyph}"]`)!
    expect(mark.children).toHaveLength(1)
    expect(mark.firstElementChild).toHaveClass('block', 'size-2', 'rounded-full', paint)
  })

  it('keeps the ask mark unchanged', () => {
    const { container } = render(<WorkerDockGlyph glyph="ask" still />)
    const mark = container.querySelector('[data-worker-dock-glyph="ask"]')!
    expect(mark.children).toHaveLength(1)
    expect(mark.firstElementChild).toHaveClass('size-3')
    expect(container.querySelector('[data-worker-dock-dot-grid]')).toBeNull()
  })

  it('keeps the spinner for running rows in the open panel', () => {
    const { container } = render(<WorkerDockGlyph glyph="running" />)
    expect(container.querySelector('[data-agent-spinner]')).not.toBeNull()
    expect(container.querySelector('[data-worker-dock-dot-grid]')).toBeNull()
  })
})

describe('WorkerDockPill', () => {
  const pill = (expanded: boolean) => (
    <WorkerDockPill
      pill={{ current: null }}
      glyph="running"
      label="3 workers"
      latest="Fix app rail spacing"
      total={3}
      expanded={expanded}
      listId="workers"
      onToggle={() => {}}
      onKeyDown={() => {}}
    />
  )

  it('shows the dot grid on the folded chip with its accessible name unchanged', () => {
    const { container, getByRole } = render(pill(false))
    expect(container.querySelector('[data-worker-dock-dot-grid]')?.children).toHaveLength(9)
    expect(getByRole('button')).toHaveAccessibleName('3 workers, latest: Fix app rail spacing')
  })

  it('drops the mark once the chip is the open panel header', () => {
    const { container } = render(pill(true))
    expect(container.querySelector('[data-worker-dock-glyph]')).toBeNull()
  })
})
