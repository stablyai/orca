// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { NewWorkspaceComposerProjectSection } from './NewWorkspaceComposerProjectSection'
import type { CloudOnlyRepo } from './run-on/use-cloud-only-repo'

afterEach(cleanup)

function cloudOnly(
  moreAccess: () => void,
  githubHandoff: CloudOnlyRepo['githubHandoff'] = 'idle',
  checkGitHubAgain: () => void = () => {}
): CloudOnlyRepo {
  return {
    repos: [],
    showMore: null,
    picked: null,
    folderProject: false,
    githubStep: null,
    pick: () => {},
    clear: () => {},
    moreAccess,
    githubHandoff,
    checkGitHubAgain,
    start: async () => false
  }
}

function renderSection(
  recipeId: string | null,
  moreAccess: () => void,
  githubHandoff: CloudOnlyRepo['githubHandoff'] = 'idle',
  checkGitHubAgain: () => void = () => {}
): void {
  render(
    <TooltipProvider>
      <NewWorkspaceComposerProjectSection
        projectError={null}
        selectedRepoConnectionId={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        projectOptions={[]}
        selectedProjectId={null}
        onProjectChange={() => {}}
        projectDescriptionId="project-description"
        onAddProject={() => {}}
        onAddProjectEntryRequest={() => {}}
        handleOpenRemoteHostDialog={() => {}}
        focusNameInput={() => {}}
        shouldShowRunTargetPicker={false}
        projectHostSetupOptions={[]}
        selectedProjectHostSetupId={null}
        handleProjectHostSetupChange={() => {}}
        ephemeralVmRecipes={[]}
        selectedEphemeralVmRecipeId={recipeId}
        onEphemeralVmRecipeChange={() => {}}
        cloudStart={{
          onSelectOrcaCloud: () => {},
          onUserPick: () => {},
          cloudOnly: cloudOnly(moreAccess, githubHandoff, checkGitHubAgain)
        }}
        handleAddSshHost={() => {}}
        handleAddRemoteServer={() => {}}
        handleConnectRunTargetHost={async () => {}}
        handleSetLocation={() => {}}
        onConnectSelectedRepo={async () => {}}
        sshStatusLabel="Connected"
        connectButtonLabel="Connect"
        selectedProjectName=""
      />
    </TooltipProvider>
  )
}

vi.mock('@/components/new-workspace/use-recent-project-ids', () => ({
  useRecentProjectIds: () => []
}))
vi.mock('@/components/sidebar/host-admission/ssh/AddRemoteHostDialog', () => ({
  AddRemoteHostDialog: () => null
}))

describe('the Add project button beside Project (PROJ-MENU part 2, n29)', () => {
  it('offers "Add a GitHub repository…" in an Orca Cloud group while Run on is Orca Cloud', async () => {
    const user = userEvent.setup()
    const more = vi.fn()
    renderSection(ORCA_CLOUD_RECIPE_ID, more)
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await screen.findByRole('menuitem', { name: /Browse folder/ })
    expect(screen.getByText('Orca Cloud')).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: 'Add a GitHub repository…' }))
    expect(more).toHaveBeenCalledOnce()
  })

  it('leaves the menu as it was on a computer or server', async () => {
    const user = userEvent.setup()
    renderSection(null, vi.fn())
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await screen.findByRole('menuitem', { name: /Browse folder/ })
    expect(screen.queryByText('Add a GitHub repository…')).toBeNull()
  })
})

describe('back from GitHub (REPO-ACCESS-REFRESH)', () => {
  it('says "Waiting for GitHub access…" under Project while the list re-reads', () => {
    renderSection(ORCA_CLOUD_RECIPE_ID, vi.fn(), 'waiting')
    expect(screen.getByRole('status').textContent).toBe('Waiting for GitHub access…')
  })

  it('when the wait runs out, says so and offers one more look; the list stays usable', async () => {
    const user = userEvent.setup()
    const checkAgain = vi.fn()
    renderSection(ORCA_CLOUD_RECIPE_ID, vi.fn(), 'timed-out', checkAgain)
    expect(screen.getByRole('status').textContent).toContain('No new repository yet.')
    expect(screen.queryByText('Waiting for GitHub access…')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(checkAgain).toHaveBeenCalledOnce()
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeTruthy()
  })
})
