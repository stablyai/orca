// why: the menu renders through React DOM, so @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddToTowerEntryContext } from '../../lineage-members/add-to-tower-entry'
import { SourceControlHeaderOverflowMenu } from './header-overflow-menu'

afterEach(cleanup)

function renderMenu(entry: { parentWorkspaceKey: string; onChanged: () => void } | null): void {
  render(
    <TooltipProvider>
      <AddToTowerEntryContext.Provider value={entry}>
        <SourceControlHeaderOverflowMenu
          sourceControlViewMode="list"
          viewModeToggleDisabled={false}
          onToggleViewMode={() => {}}
          onChangeBaseRef={() => {}}
          onRefreshBranchCompare={() => {}}
          branchCompareRefreshDisabled={false}
          diffCommentCount={0}
          onExpandNotes={() => {}}
        />
      </AddToTowerEntryContext.Provider>
    </TooltipProvider>
  )
}

describe('SourceControlHeaderOverflowMenu add-to-tower entry', () => {
  it('opens the shared dialog from the overflow menu when lineage is supported', async () => {
    const user = userEvent.setup()
    renderMenu({ parentWorkspaceKey: 'worktree:r::/w', onChanged: () => {} })
    await user.click(screen.getByRole('button', { name: 'More source control actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add to control tower…' }))
    expect(await screen.findByRole('dialog', { name: 'Add to control tower' })).toBeTruthy()
  })

  it('leaves the menu unchanged without lineage support', async () => {
    const user = userEvent.setup()
    renderMenu(null)
    await user.click(screen.getByRole('button', { name: 'More source control actions' }))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Add to control tower…' })).toBeNull()
  })
})
