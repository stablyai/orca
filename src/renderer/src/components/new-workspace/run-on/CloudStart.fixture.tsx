// "Start in Orca Cloud" frames from the cloud-start-onboarding spec: E1–E4, A1, A7, A8, E, X2.
import React, { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
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
import { NewWorkspaceMoreMenu } from '../../sidebar/NewWorkspaceMoreMenu'
import { LandingCloudCard } from '../../landing/LandingCloudCard'
import { EmptyState } from '../../cloud-workspaces/CloudWorkspacesStates'

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

function ComposerPreview({
  availability,
  access,
  cloudSelected,
  steps: pinnedSteps,
  allSet = false,
  tracker = false
}: {
  availability: OrcaCloudAvailability
  access: OrcaCloudRunTargetAccess
  cloudSelected: boolean
  steps?: CloudSetupStep[]
  allSet?: boolean
  /** A7: the setup session is open in the browser. */
  tracker?: boolean
}): React.JSX.Element {
  const [host, setHost] = useState('local')
  const [recipe, setRecipe] = useState<string | null>(cloudSelected ? 'cloud' : null)
  const steps = pinnedSteps ?? deriveCloudSetupSteps({ availability, access })
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
      <p className="text-sm text-muted-foreground">Fix the flaky login test in e2e/auth.spec.ts.</p>
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
        cloudStart={
          tracker
            ? {
                ...cloudStart,
                steps: steps.map((s) => (s.id === 'plan' ? { ...s, state: 'active' } : s))
              }
            : cloudStart
        }
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

const setup = (): void => {
  window.api.agentApiKeys = undefined
  window.api.cloudSecrets = undefined
  window.api.cloudWorkspaces = { ...window.api.cloudWorkspaces, available: async () => true }
}
const entitled: OrcaCloudRunTargetAccess = { state: 'entitled', remainingSeconds: 41 * 3600 }

/** E1: Run on as segments, this computer picked. */
export const e1RunOnDefault = defineFixture({
  width: 560,
  setup,
  render: () => <ComposerPreview availability="offered" access={entitled} cloudSelected={false} />
})
/** E1 with "⋯" open: today's host picker without the Orca Cloud row. */
export const e1MorePlaces = defineFixture({
  ...e1RunOnDefault,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[aria-label="More places to run"]')?.click()
  }
})
/** A1: Orca Cloud picked while signed out; one setup trip. */
export const a1SignedOut = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview availability="needs-sign-in" access={{ state: 'signed-out' }} cloudSelected />
  )
})
/** A7: Finish in your browser (the plan step is open in the browser). */
export const a7FinishInBrowser = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      tracker
      steps={[
        { id: 'account', state: 'done', detail: 'neil@acme.dev' },
        { id: 'plan', state: 'active' },
        { id: 'agent', state: 'optional' }
      ]}
    />
  )
})
/** A8: everything done; "All set", then the composer starts by itself. */
export const a8AllSet = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      allSet
      steps={[
        { id: 'account', state: 'done', detail: 'neil@acme.dev' },
        { id: 'plan', state: 'done', detail: 'acme · 60 sandbox hours left' },
        { id: 'agent', state: 'optional' }
      ]}
    />
  )
})
/** E: returning, entitled; remembered Orca Cloud, no panel, "Start in Orca Cloud". */
export const eReturning = defineFixture({
  width: 560,
  setup,
  render: () => <ComposerPreview availability="offered" access={entitled} cloudSelected />
})
/** X2: Orca Cloud can't be reached; the segment stays, disabled, with a tooltip. */
export const x2Unreachable = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="unreachable"
      access={{ state: 'unknown' }}
      cloudSelected={false}
    />
  ),
  interact: async (frame) => {
    frame
      .querySelector('[role="radio"][aria-disabled="true"]')
      ?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})
/** E2: the sidebar New workspace chevron menu. */
export const e2SidebarMenu = defineFixture({
  width: 320,
  setup,
  render: () => (
    <div className="flex justify-end p-3">
      <NewWorkspaceMoreMenu preserveWorkspaceBoardOpen={false} />
    </div>
  ),
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    frame
      .querySelector<HTMLButtonElement>('[aria-label="More ways to create"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})
/** E3: Landing's first-run card. */
export const e3LandingCard = defineFixture({
  width: 520,
  setup,
  render: () => (
    <div className="p-4">
      <LandingCloudCard cloudWorkspacesPresent={false} />
    </div>
  )
})
/** E4: Cloud workspaces empty (Mine) with a real button. */
export const e4CloudHomeEmpty = defineFixture({
  width: 560,
  setup,
  render: () => <EmptyState scope="mine" archived={false} filtered={false} />
})
