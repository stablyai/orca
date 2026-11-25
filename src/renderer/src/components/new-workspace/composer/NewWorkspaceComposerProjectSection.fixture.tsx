import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { NewWorkspaceProjectOption } from '@/lib/workspace/creation/new-workspace-project-options'
import {
  getProjectHostSetupSelectionKey,
  type ProjectHostSetupOption
} from '@/lib/workspace/creation/project-host-setup-options'
import { NewWorkspaceComposerProjectSection } from './NewWorkspaceComposerProjectSection'

const orcaRepo: Repo = {
  id: 'orca-local',
  path: '/Users/alice/Projects/orca',
  displayName: 'orca',
  badgeColor: '#8b5cf6',
  repoIcon: {
    type: 'image',
    source: 'upload',
    src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="12" fill="%2309090b"/><circle cx="12" cy="12" r="9" fill="none" stroke="%23ffffff" stroke-width="1.5"/><circle cx="12" cy="12" r="5" fill="%23ffffff"/><circle cx="9.5" cy="9.5" r="2" fill="%2309090b"/></svg>'
  },
  addedAt: 1
}

const personalOrcaRepo: Repo = {
  id: 'personal-orca-local',
  path: '/Users/alice/Projects/personal-orca',
  displayName: 'orca-cloud',
  badgeColor: '#14b8a6',
  repoIcon: null,
  addedAt: 2
}

const apiRepo: Repo = {
  id: 'api-local',
  path: '/Users/alice/Projects/platform-api',
  displayName: 'platform-api',
  badgeColor: '#ef4444',
  repoIcon: null,
  addedAt: 3
}

const fixtureRepos = [orcaRepo, personalOrcaRepo, apiRepo]

const projects: NewWorkspaceProjectOption[] = [
  {
    kind: 'project',
    id: 'orca',
    projectId: 'orca',
    displayName: 'orca',
    badgeColor: orcaRepo.badgeColor,
    repo: orcaRepo,
    detail: 'stablyai/orca'
  },
  {
    kind: 'project',
    id: 'personal-orca',
    projectId: 'personal-orca',
    displayName: 'orca-cloud',
    badgeColor: personalOrcaRepo.badgeColor,
    repo: personalOrcaRepo,
    detail: 'stablyai/orca-cloud'
  },
  {
    kind: 'project',
    id: 'api',
    projectId: 'api',
    displayName: 'platform-api',
    badgeColor: apiRepo.badgeColor,
    repo: apiRepo,
    detail: 'stablyai/platform-api'
  },
  {
    kind: 'project-group',
    id: 'folder',
    projectGroupId: 'folder',
    displayName: 'Design workspace',
    badgeColor: 'var(--muted-foreground)',
    detail: '/Users/alice/Projects/design',
    parentPath: '/Users/alice/Projects/design',
    connectionId: null
  }
]
const hosts: ProjectHostSetupOption[] = [
  {
    kind: 'ready',
    id: 'local',
    projectId: 'orca',
    repoId: 'orca-local',
    hostId: 'local',
    label: 'MacBook Pro',
    detail: 'Local',
    path: '/Users/alice/Projects/orca'
  },
  {
    kind: 'ready',
    id: 'remote',
    projectId: 'orca',
    repoId: 'orca-remote',
    hostId: 'ssh:devbox',
    label: 'Dev server',
    detail: 'SSH',
    path: '/home/alice/projects/orca'
  },
  {
    kind: 'needs-setup',
    id: 'windows',
    projectId: 'orca',
    hostId: 'runtime:windows',
    label: 'Windows workstation',
    detail: 'Project location not set',
    isAvailable: true,
    attention: false,
    canSetLocation: true
  }
]

function ProjectAndHostPreview({
  folderOnly = false
}: {
  folderOnly?: boolean
}): React.JSX.Element {
  const [project, setProject] = useState(folderOnly ? 'folder' : 'orca')
  const [host, setHost] = useState('local')
  return (
    <div className="space-y-4 rounded-xl border border-border bg-background p-4">
      <h1 className="text-base font-semibold">New worktree</h1>
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
        onAddProjectEntryRequest={() => {}}
        handleOpenRemoteHostDialog={() => {}}
        focusNameInput={() => {}}
        shouldShowRunTargetPicker={!folderOnly}
        projectHostSetupOptions={hosts}
        selectedProjectHostSetupId={host}
        handleProjectHostSetupChange={(key) => {
          const option = hosts.find(
            (candidate) => getProjectHostSetupSelectionKey(candidate) === key
          )
          if (option) {
            setHost(option.id)
          }
        }}
        ephemeralVmRecipes={[]}
        handleAddSshHost={() => {}}
        handleAddRemoteServer={() => {}}
        handleConnectRunTargetHost={async () => {}}
        handleSetLocation={() => {}}
        onConnectSelectedRepo={async () => {}}
        sshStatusLabel="Connected"
        connectButtonLabel="Connect"
        selectedProjectName="orca"
      />
    </div>
  )
}

export const closed = defineFixture({
  width: 560,
  store: { repos: fixtureRepos },
  render: () => <ProjectAndHostPreview />
})
export const narrow = defineFixture({
  width: 360,
  store: { repos: fixtureRepos },
  render: () => <ProjectAndHostPreview />
})
export const folderOnly = defineFixture({
  width: 560,
  store: { repos: fixtureRepos },
  render: () => <ProjectAndHostPreview folderOnly />
})
export const projectMenu = defineFixture({
  ...closed,
  interact: (frame) => {
    frame.querySelector<HTMLInputElement>('[aria-label="Project"][role="combobox"]')?.focus()
  }
})
export const hostMenu = defineFixture({
  ...closed,
  interact: (frame) => {
    frame.querySelector<HTMLInputElement>('[aria-label="Run on"][role="combobox"]')?.focus()
  }
})

export const narrowProjectMenu = defineFixture({ ...projectMenu, width: 360 })
export const narrowHostMenu = defineFixture({ ...hostMenu, width: 360 })

function tooltipFixture(attribute: string) {
  return defineFixture({
    ...closed,
    interact: async (frame) => {
      frame
        .querySelector(`div[${attribute}]`)
        ?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })
}

export const projectTooltip = tooltipFixture('data-project-combobox-root')
export const hostTooltip = tooltipFixture('data-run-target-combobox-root')
