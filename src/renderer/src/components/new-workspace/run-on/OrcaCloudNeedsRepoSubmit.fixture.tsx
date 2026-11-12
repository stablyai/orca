// RR-c1 (Neil): submit-time validation, end to end in the composer's Project row and footer:
// silent while picking, an error under Project after Create, and gone once a GitHub repo is picked.
import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { NewWorkspaceProjectOption } from '@/lib/workspace/creation/new-workspace-project-options'
import { NewWorkspaceComposerProjectSection } from '../NewWorkspaceComposerProjectSection'
import { NewWorkspaceComposerFooter } from '../NewWorkspaceComposerFooter'
import type { EphemeralVmRecipeOption } from '../run-target-options'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { useNeedsRepoSubmitGuard } from './use-needs-repo-submit-guard'

const projects: NewWorkspaceProjectOption[] = [
  {
    kind: 'project-group',
    id: 'folder',
    projectGroupId: 'folder',
    displayName: 'Design workspace',
    badgeColor: 'var(--muted-foreground)',
    detail: '/Users/alice/Projects/design',
    parentPath: '/Users/alice/Projects/design',
    connectionId: null
  },
  {
    kind: 'project',
    id: 'hello',
    projectId: 'hello',
    displayName: 'Hello-World',
    badgeColor: 'var(--muted-foreground)',
    detail: 'octocat/Hello-World'
  }
]
const orcaCloud: EphemeralVmRecipeOption = {
  id: ORCA_CLOUD_RECIPE_ID,
  name: 'Orca Cloud',
  description: 'Hosted by Orca. Sleeps when idle and keeps your files.',
  provider: 'orca-cloud',
  create: 'orca-cloud create'
}
const NEEDS_REPO = { hasRepos: true }

function Composer(): React.JSX.Element {
  const [project, setProject] = useState('folder')
  const [created, setCreated] = useState(false)
  const needsRepo = project === 'folder' ? NEEDS_REPO : null
  const guard = useNeedsRepoSubmitGuard(needsRepo, () => setCreated(true))
  const cloudStart = {
    onSelectOrcaCloud: () => {},
    onUserPick: () => {},
    folderProject: project === 'folder',
    needsGitHubRepo: guard.shown
  }
  return (
    <div className="w-[520px] space-y-4 rounded-xl border border-border bg-background p-4">
      <h1 className="text-base font-semibold">Create workspace</h1>
      <NewWorkspaceComposerProjectSection
        projectError={null}
        selectedRepoConnectionId={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        projectOptions={projects}
        selectedProjectId={project}
        onProjectChange={setProject}
        projectDescriptionId="fixture-project-description"
        onAddProject={() => {}}
        focusNameInput={() => {}}
        shouldShowRunTargetPicker
        projectHostSetupOptions={[]}
        selectedProjectHostSetupId={null}
        handleProjectHostSetupChange={() => {}}
        ephemeralVmRecipes={[orcaCloud]}
        selectedEphemeralVmRecipeId={ORCA_CLOUD_RECIPE_ID}
        onEphemeralVmRecipeChange={() => {}}
        orcaCloudAccess={{ state: 'entitled', remainingSeconds: 41 * 3600 }}
        handleAddSshHost={() => {}}
        handleAddRemoteServer={() => {}}
        handleConnectRunTargetHost={async () => {}}
        handleSetLocation={() => {}}
        onConnectSelectedRepo={async () => {}}
        sshStatusLabel="Connected"
        connectButtonLabel="Connect"
        selectedProjectName={project === 'folder' ? 'Design workspace' : 'Hello-World'}
        cloudStart={cloudStart}
      />
      <NewWorkspaceComposerFooter
        onCreate={guard.onPrimary}
        createError={null}
        createDisabled={false}
        creating={created}
        primaryActionLabel="Create workspace"
        submitShortcutModifierLabel="⌘"
        cloudStart={cloudStart}
      />
      {/* Fixture-only: switches the project the way the Project picker does. */}
      <button type="button" hidden data-fixture-pick-github onClick={() => setProject('hello')} />
    </div>
  )
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const clickCreate = (frame: HTMLElement): void =>
  [...frame.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes('Create workspace'))
    ?.click()

const base = {
  width: 560,
  setup: () => {
    window.api.agentApiKeys = undefined
    window.api.cloudSecrets = undefined
  },
  render: () => <Composer />
}

/** Orca Cloud on a plain folder, before Create: Create enabled, no message. */
export const beforeSubmit = defineFixture(base)
/** Create pressed: nothing submitted; the error under Project, focus on the Project field. */
export const afterFailedSubmit = defineFixture({
  ...base,
  interact: async (frame) => {
    clickCreate(frame)
    await wait(200)
  }
})
/** A GitHub repository picked after the error: the error clears, and Create is ready. */
export const fixed = defineFixture({
  ...base,
  interact: async (frame) => {
    clickCreate(frame)
    await wait(150)
    frame.querySelector<HTMLButtonElement>('[data-fixture-pick-github]')?.click()
    await wait(200)
  }
})
