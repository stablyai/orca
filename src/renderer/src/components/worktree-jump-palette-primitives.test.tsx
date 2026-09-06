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

it('exposes the extra secondary matches to pointer and keyboard users', () => {
  renderPrimaryLine([
    { text: 'src/app.ts', ranges: [] },
    { text: 'src/deep/nested.ts', ranges: [] },
    { text: 'docs/readme.md', ranges: [] }
  ])

  const badge = screen.getByText('+2')
  expect(badge.getAttribute('aria-label')).toBe('src/deep/nested.ts, docs/readme.md')
  expect(badge.tabIndex).toBe(0)
})

it('renders no badge when every secondary match is already shown', () => {
  renderPrimaryLine([{ text: 'src/app.ts', ranges: [] }])

  expect(screen.queryByText(/^\+\d+$/)).toBeNull()
})
