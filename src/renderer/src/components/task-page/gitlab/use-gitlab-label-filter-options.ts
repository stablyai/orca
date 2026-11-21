import type { PickerOption } from '@/components/github/PRFilterPickers'
import { createMetadataRequestStore } from '@/lib/work-items/metadata/metadata-request-cache'
import { useMetadataListRequest } from '@/lib/work-items/metadata/useMetadataListRequest'
import { useTranslate } from '@/i18n/use-translate'
import { gitLabApiFor } from '@/runtime/repository-gitlab/gitlab-owner-api'
import { isGitLabLabelFilterName } from '../../../../../shared/gitlab/gitlab-label-names'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { gitLabTaskRepoSelector } from './gitlab-task-repo-selector'

const labelStore = createMetadataRequestStore<string[]>()

export function useGitLabLabelFilterOptions(repo: Repo | null): {
  options: PickerOption[]
  loading: boolean
  error: string | null
} {
  const t = useTranslate()
  const errorFallback = t(
    'auto.components.TaskPage.gitlabLabelsLoadFailed',
    'Could not load labels.'
  )
  const selector = repo ? gitLabTaskRepoSelector(repo) : null
  // Why: the lookup follows the repo's issue source, which the selector does not carry.
  const cacheKey = repo ? JSON.stringify([selector, repo.issueSourcePreference ?? 'auto']) : null
  const state = useMetadataListRequest({
    cacheKey,
    store: labelStore,
    errorFallback,
    load: () =>
      selector
        ? gitLabApiFor(selector)
            .listLabels(selector)
            .catch(() => {
              // Why: the raw glab output is a long URL that the narrow popover clips.
              throw new Error(errorFallback)
            })
        : Promise.resolve([])
  })
  if (!selector) {
    return { options: [], loading: false, error: null }
  }
  return {
    options: [
      ...new Set((state.resolvedKey === cacheKey ? state.data : []).filter(isGitLabLabelFilterName))
    ].map((name) => ({
      key: name,
      primary: name
    })),
    loading: state.loading,
    error: state.error
  }
}
