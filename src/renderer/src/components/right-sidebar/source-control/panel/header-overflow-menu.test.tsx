// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SourceControlHeaderOverflowMenu } from './header-overflow-menu'

function renderMenu(overrides?: {
  openDiffsInSideSplit?: boolean
  onToggleOpenDiffsInSideSplit?: () => void
}): void {
  render(
    <TooltipProvider>
      <SourceControlHeaderOverflowMenu
        sourceControlViewMode="list"
        viewModeToggleDisabled={false}
        onToggleViewMode={vi.fn()}
        onChangeBaseRef={vi.fn()}
        onRefreshBranchCompare={vi.fn()}
        branchCompareRefreshDisabled={false}
        diffCommentCount={0}
        onExpandNotes={vi.fn()}
        openDiffsInSideSplit={overrides?.openDiffsInSideSplit ?? false}
        onToggleOpenDiffsInSideSplit={overrides?.onToggleOpenDiffsInSideSplit ?? vi.fn()}
      />
    </TooltipProvider>
  )
}

// Why: Radix marks open menu content pointer-events: none, which userEvent's default check rejects.
const user = userEvent.setup({ pointerEventsCheck: 0 })

async function openMenu(): Promise<void> {
  await user.click(screen.getByRole('button', { name: /more source control actions/i }))
}

describe('SourceControlHeaderOverflowMenu side-split toggle', () => {
  // Why: this config has no global auto-cleanup, so a leftover tree makes the next getByRole ambiguous.
  afterEach(cleanup)

  // Why: changed mid-review, so it must be reachable from the panel, not only Settings.
  it('offers the side-split toggle, reflecting the current setting', async () => {
    renderMenu({ openDiffsInSideSplit: true })
    await openMenu()

    const item = screen.getByRole('menuitemcheckbox', { name: /open diffs in a side split/i })
    expect(item.getAttribute('aria-checked')).toBe('true')
  })

  it('shows it unchecked when the setting is off', async () => {
    renderMenu({ openDiffsInSideSplit: false })
    await openMenu()

    expect(
      screen
        .getByRole('menuitemcheckbox', { name: /open diffs in a side split/i })
        .getAttribute('aria-checked')
    ).toBe('false')
  })

  it('reports the toggle when selected', async () => {
    const onToggle = vi.fn()
    renderMenu({ openDiffsInSideSplit: false, onToggleOpenDiffsInSideSplit: onToggle })
    await openMenu()

    await user.click(screen.getByRole('menuitemcheckbox', { name: /open diffs in a side split/i }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
