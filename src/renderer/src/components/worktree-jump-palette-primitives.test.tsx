// @vitest-environment happy-dom

import { cleanup, render, type RenderResult, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PaletteLocationChip, PaletteOpenTabPrimaryLine } from './worktree-jump-palette-primitives'

afterEach(() => cleanup())

function renderPrimaryLine(
  secondaryMatches: readonly { text: string; ranges: readonly never[] }[]
): RenderResult {
  return render(
    <TooltipProvider>
      <PaletteOpenTabPrimaryLine
        title="Terminal"
        titleRanges={[]}
        secondaryText="src/app.ts"
        secondaryRanges={[]}
        secondaryMatches={secondaryMatches}
      />
    </TooltipProvider>
  )
}

it('exposes the extra secondary matches through the row text, not the tab order', () => {
  const { container } = renderPrimaryLine([
    { text: 'src/app.ts', ranges: [] },
    { text: 'src/deep/nested.ts', ranges: [] },
    { text: 'docs/readme.md', ranges: [] }
  ])

  const extraMatches = container.querySelector('[data-slot="palette-open-tab-extra-matches"]')
  expect(extraMatches?.textContent).toBe('src/deep/nested.ts, docs/readme.md')

  const badge = screen.getByText('+2')
  expect(badge.getAttribute('aria-hidden')).toBe('true')
  expect(badge.tabIndex).toBe(-1)
})

it('renders no badge when every secondary match is already shown', () => {
  renderPrimaryLine([{ text: 'src/app.ts', ranges: [] }])

  expect(screen.queryByText(/^\+\d+$/)).toBeNull()
})

it('elides a deep path from the head so the matched tail stays visible', () => {
  const path = '/Users/me/projects/orca/new-create-button-design/proposals/create-button.html'
  const start = path.indexOf('create-butt')
  const { container } = render(
    <TooltipProvider>
      <PaletteOpenTabPrimaryLine
        title="Design"
        titleRanges={[]}
        secondaryText={path}
        secondaryRanges={[{ start, end: start + 'create-butt'.length }]}
      />
    </TooltipProvider>
  )

  const secondary = container.querySelector('[data-slot="palette-open-tab-secondary"]')
  expect(secondary?.textContent).toBe(path)
  const [head, tail] = Array.from(secondary?.children ?? [])
  expect(head?.textContent).toBe('/Users/me/projects/orca')
  expect(tail?.textContent).toBe('/new-create-button-design/proposals/create-button.html')
  expect(tail?.querySelector('.font-semibold')?.textContent).toBe('create-butt')
})

it('folds the worktree into the repo chip and drops it when it repeats the repo name', () => {
  const { container, rerender } = render(
    <TooltipProvider>
      <PaletteLocationChip
        repoName="orca"
        repoRanges={[]}
        worktreeName="new-create-button-design"
        worktreeRanges={[]}
      />
    </TooltipProvider>
  )
  expect(container.querySelector('[data-slot="palette-location-chip"]')?.textContent).toBe(
    'orca·new-create-button-design'
  )
  const chip = container.querySelector('[data-slot="palette-location-chip"]')
  const repo = container.querySelector('[data-slot="palette-location-repo"]')
  const worktree = container.querySelector('[data-slot="palette-open-tab-worktree"]')
  expect(chip?.className).toContain('overflow-hidden')
  expect(chip?.className).toContain('min-w-0')
  expect(repo?.className).toContain('max-w-[55%]')
  expect(repo?.className).toContain('min-w-[3ch]')
  expect(worktree?.className).toContain('min-w-[3ch]')
  expect(worktree?.getAttribute('data-state')).toBeNull()
  expect(worktree?.getAttribute('tabindex')).toBeNull()

  rerender(
    <TooltipProvider>
      <PaletteLocationChip
        repoName="orca"
        repoRanges={[]}
        worktreeName="orca"
        worktreeRanges={[{ start: 0, end: 4 }]}
      />
    </TooltipProvider>
  )
  expect(container.querySelector('[data-slot="palette-location-chip"]')?.textContent).toBe('orca')
  expect(
    container.querySelector('[data-slot="palette-location-repo"] .font-semibold')?.textContent
  ).toBe('orca')
})

it('keeps a short title at its natural width so the session age stays beside it', () => {
  const { container } = render(
    <TooltipProvider>
      <PaletteOpenTabPrimaryLine
        title="Terminal 1"
        titleRanges={[]}
        secondaryText=""
        secondaryRanges={[]}
        sessionAge="2d"
      />
    </TooltipProvider>
  )

  const title = container.querySelector('[data-slot="palette-open-tab-title"]')
  expect(title?.className).toContain('min-w-0')
  expect(title?.className).not.toContain('shrink-0')
})

it('caps the title only when it shares the line with secondary text', () => {
  const { container } = renderPrimaryLine([])

  const title = container.querySelector('[data-slot="palette-open-tab-title"]')
  expect(title?.className).toContain('max-w-[62%]')
  expect(title?.className).toContain('shrink-0')
})
