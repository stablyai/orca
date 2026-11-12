import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { RepositoryRemoveProjectSection } from './RepositoryRemoveProjectSection'

const repo: Repo = {
  id: 'repo-1',
  path: '/Users/dev/orca',
  displayName: 'orca',
  badgeColor: '#3b82f6',
  addedAt: 0
}

function setup(id: string, hostId: ProjectHostSetup['hostId'], path: string): ProjectHostSetup {
  return {
    id,
    projectId: 'project-1',
    hostId,
    repoId: `repo-${id}`,
    path,
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 0,
    updatedAt: 0
  }
}

const setups = [
  setup('a', 'local', '/Users/dev/orca'),
  setup('b', 'local', '/Users/dev/orca/workspaces/orca'),
  setup('c', 'ssh:openclaw', '/home/dev/orca')
]

const entry = { title: 'Remove project', description: '', keywords: ['remove'] }

export const collapsed = defineFixture({
  width: 720,
  render: () => (
    <RepositoryRemoveProjectSection
      repo={repo}
      setups={setups}
      removalScope="project"
      searchEntry={entry}
      forceVisible
      removeProject={() => {}}
    />
  )
})

export const expanded = defineFixture({
  ...collapsed,
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')?.click()
  }
})

export const confirmDialog = defineFixture({
  ...collapsed,
  interact: (frame) => {
    ;[...frame.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Remove…'))
      ?.click()
  }
})
