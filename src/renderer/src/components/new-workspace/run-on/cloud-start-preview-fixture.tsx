// Shared preview for the cloud-start fixtures: the composer's project section and footer wired to
// the pure setup model, so every spec frame renders without a store or network.
import React, { useState } from 'react'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import { NewWorkspaceComposerProjectSection } from '../NewWorkspaceComposerProjectSection'
import { NewWorkspaceComposerFooter } from '../NewWorkspaceComposerFooter'
import type { EphemeralVmRecipeOption } from '../run-target-options'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import {
  deriveCloudSetupSteps,
  getCloudPrimaryAction,
  isCloudSetupPanelVisible,
  type CloudSetupStep
} from './cloud-start-model'
import type { CloudStartView } from './use-cloud-start-composer'
import { getCloudPrimaryLabel } from './cloud-start-actions'
import { decorateCloudSetupStep } from './use-cloud-start-steps'

const projects: NewWorkspaceProjectOption[] = [
  {
    kind: 'project',
    id: 'web',
    projectId: 'web',
    displayName: 'acme/web',
    badgeColor: 'var(--muted-foreground)',
    detail: 'acme/web'
  }
]
const hosts: ProjectHostSetupOption[] = [
  {
    kind: 'ready',
    id: 'local',
    projectId: 'web',
    repoId: 'web',
    hostId: 'local',
    label: 'MacBook Pro',
    detail: '~/code/acme-web',
    path: '/Users/neil/code/acme-web'
  },
  {
    kind: 'ready',
    id: 'devbox',
    projectId: 'web',
    repoId: 'web-devbox',
    hostId: 'ssh:devbox',
    label: 'devbox',
    detail: 'SSH',
    path: '/home/neil/acme-web'
  }
]
const orcaCloudRecipe: EphemeralVmRecipeOption = {
  id: 'cloud',
  name: 'Orca Cloud',
  description: 'Hosted by Orca. Sleeps when idle and keeps your files.',
  provider: 'orca-cloud',
  create: 'orca-cloud create'
}

export function ComposerPreview({
  availability,
  access,
  cloudSelected,
  steps: pinnedSteps,
  github = null,
  allSet = false,
  prompt = 'Fix the flaky login test in e2e/auth.spec.ts and open a PR.'
}: {
  availability: OrcaCloudAvailability
  access: OrcaCloudRunTargetAccess
  cloudSelected: boolean
  steps?: CloudSetupStep[]
  /** The GitHub row (D1–D3), as the repository check would report it. */
  github?: CloudSetupStep | null
  allSet?: boolean
  prompt?: string
}): React.JSX.Element {
  const [host, setHost] = useState('local')
  const [recipe, setRecipe] = useState<string | null>(cloudSelected ? 'cloud' : null)
  const signedOut = availability === 'needs-sign-in' || access.state === 'signed-out'
  const steps = (pinnedSteps ?? deriveCloudSetupSteps({ availability, access, github })).map(
    (step) => decorateCloudSetupStep(step, 'claude', signedOut)
  )
  const selected = recipe === 'cloud'
  const panelVisible = selected && (isCloudSetupPanelVisible(steps) || allSet)
  const action = getCloudPrimaryAction(steps)
  const cloudStart: CloudStartView = {
    steps,
    panelVisible,
    allSet,
    onSelectOrcaCloud: () => setRecipe('cloud'),
    onUserPick: () => {},
    ...(panelVisible && !allSet && action !== 'useThisComputer'
      ? { onUseThisComputer: () => setRecipe(null) }
      : {})
  }
  return (
    <div className="space-y-4 rounded-xl border border-border bg-background p-4">
      <h1 className="text-base font-semibold">Create workspace</h1>
      <p className="text-sm text-muted-foreground">{prompt}</p>
      <NewWorkspaceComposerProjectSection
        projectError={null}
        selectedRepoConnectionId={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        projectOptions={projects}
        selectedProjectId="web"
        onProjectChange={() => {}}
        projectDescriptionId="fixture-project-description"
        onAddProject={() => {}}
        focusNameInput={() => {}}
        shouldShowRunTargetPicker
        projectHostSetupOptions={hosts}
        selectedProjectHostSetupId={host}
        handleProjectHostSetupChange={(id) => setHost(id)}
        ephemeralVmRecipes={availability === 'offered' ? [orcaCloudRecipe] : []}
        selectedEphemeralVmRecipeId={recipe}
        onEphemeralVmRecipeChange={setRecipe}
        orcaCloudAvailability={availability}
        orcaCloudAccess={access}
        cloudStart={cloudStart}
        handleAddSshHost={() => {}}
        handleAddRemoteServer={() => {}}
        handleConnectRunTargetHost={async () => {}}
        handleSetLocation={() => {}}
        onConnectSelectedRepo={async () => {}}
        sshStatusLabel="Connected"
        connectButtonLabel="Connect"
        selectedProjectName="acme/web"
      />
      <NewWorkspaceComposerFooter
        createError={null}
        onCreate={() => {}}
        createDisabled={allSet || action === 'checking'}
        creating={allSet}
        primaryActionLabel={
          selected ? getCloudPrimaryLabel(allSet ? 'start' : action) : 'Create worktree'
        }
        submitShortcutModifierLabel="⌘"
        cloudStart={cloudStart}
      />
    </div>
  )
}
