// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PaletteOpenTabPrimaryLine } from './worktree-jump-palette-primitives'

afterEach(() => cleanup())

function renderPrimaryLine(
  secondaryMatches: readonly { text: string; ranges: readonly never[] }[]
): void {
  render(
    <TooltipProvider>
      <PaletteOpenTabPrimaryLine
        title="Terminal"
        titleRanges={[]}
        secondaryText="src/app.ts"
        secondaryRanges={[]}
        secondaryMatches={secondaryMatches}
        worktreeName="Workspace"
        worktreeRanges={[]}
      />
    </TooltipProvider>
  )
}

it('exposes the extra secondary matches without adding a palette tab stop', () => {
  renderPrimaryLine([
    { text: 'src/app.ts', ranges: [] },
    { text: 'src/deep/nested.ts', ranges: [] },
    { text: 'docs/readme.md', ranges: [] }
  ])

  expect(screen.getByText('src/deep/nested.ts, docs/readme.md')).toBeTruthy()
  const badge = screen.getByText('+2')
  expect(badge.getAttribute('aria-hidden')).toBe('true')
  expect(badge.tabIndex).toBe(-1)
})

it('renders no badge when every secondary match is already shown', () => {
  renderPrimaryLine([{ text: 'src/app.ts', ranges: [] }])

  expect(screen.queryByText(/^\+\d+$/)).toBeNull()
})
