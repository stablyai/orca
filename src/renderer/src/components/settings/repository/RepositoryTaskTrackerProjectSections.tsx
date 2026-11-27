import type { ComponentProps } from 'react'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { RepositoryJiraProjectSection } from './RepositoryJiraProjectSection'
import { RepositoryItsaplanProjectSection } from './RepositoryItsaplanProjectSection'

type UpdateRepo = ComponentProps<typeof RepositoryJiraProjectSection>['updateRepo'] &
  ComponentProps<typeof RepositoryItsaplanProjectSection>['updateRepo']

// Keyed by host and repo so each tracker's project picker resets when the selection moves.
export function RepositoryTaskTrackerProjectSections({
  hostId,
  repo,
  updateRepo,
  forceVisible
}: {
  hostId: string
  repo: Repo
  updateRepo: UpdateRepo
  forceVisible?: boolean
}): React.JSX.Element {
  return (
    <>
      <RepositoryJiraProjectSection
        key={`${hostId}:${repo.id}`}
        repo={repo}
        updateRepo={updateRepo}
        forceVisible={forceVisible}
      />

      <RepositoryItsaplanProjectSection
        key={`${hostId}:${repo.id}:itsaplan`}
        repo={repo}
        updateRepo={updateRepo}
        forceVisible={forceVisible}
      />
    </>
  )
}
