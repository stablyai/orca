import type { DefaultBranchWorkspaceVisibility, Repo } from '../../../../../shared/repo-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { RepositoryDefaultBranchVisibilitySection } from './RepositoryDefaultBranchVisibilitySection'

function repo(defaultBranchWorkspaceVisibility?: DefaultBranchWorkspaceVisibility): Repo {
  return {
    id: 'repo-1',
    path: '/repos/acme-web',
    displayName: 'acme-web',
    badgeColor: '#3b82f6',
    addedAt: 0,
    ...(defaultBranchWorkspaceVisibility ? { defaultBranchWorkspaceVisibility } : {})
  }
}

function fixture(visibility: DefaultBranchWorkspaceVisibility | undefined) {
  return defineFixture({
    width: 640,
    render: () => (
      <RepositoryDefaultBranchVisibilitySection repo={repo(visibility)} updateRepo={() => {}} />
    )
  })
}

export const follow = fixture(undefined)
export const alwaysHide = fixture('hide')
