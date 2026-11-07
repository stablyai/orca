import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import { FolderWorkspaceEmptyState } from './folder-workspace-empty-state'

const repo = (name: string, path = `/repo/platform/${name}`) => ({
  id: `repo-${name}`,
  path,
  displayName: name,
  badgeColor: 'blue',
  addedAt: 1
})

const props = {
  folderWorkspace: makeFolderWorkspace({ name: 'login-fix' }),
  title: 'No attached worktrees yet',
  copy: 'Worktrees created from this workspace will show up here.'
}

export const repositories = defineFixture({
  width: 305,
  store: {
    projectGroups: [makeProjectGroup()],
    repos: [
      repo('api'),
      repo('web'),
      repo('infrastructure-and-deployment-scripts'),
      repo('elsewhere', '/repo/other')
    ]
  },
  render: () => <FolderWorkspaceEmptyState {...props} />
})

export const noRepositories = defineFixture({
  width: 305,
  store: { projectGroups: [makeProjectGroup()], repos: [] },
  render: () => <FolderWorkspaceEmptyState {...props} />
})

export const narrow = defineFixture({
  width: 220,
  store: repositories.store,
  render: () => <FolderWorkspaceEmptyState {...props} />
})

// The panels give the empty state a bounded height; a long list scrolls inside it.
export const manyRepositories = defineFixture({
  width: 220,
  store: {
    projectGroups: [makeProjectGroup()],
    repos: Array.from({ length: 20 }, (_, index) => repo(`service-${index + 1}`))
  },
  render: () => (
    <div className="flex h-[400px] flex-col">
      <FolderWorkspaceEmptyState {...props} />
    </div>
  )
})
