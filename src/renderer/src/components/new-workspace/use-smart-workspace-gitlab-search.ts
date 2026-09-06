import { useEffect, useMemo } from 'react'
import {
  listGitLabMRsForSource,
  lookupGitLabWorkItemByPathForSource
} from '@/lib/gitlab-work-item-source-lookup'
import { parseGitLabIssueOrMRLink } from '@/lib/gitlab-links'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
import type { useSmartWorkspaceNameFieldFoundation } from './use-smart-workspace-name-field-foundation'

type Foundation = ReturnType<typeof useSmartWorkspaceNameFieldFoundation>

export function useSmartWorkspaceGitlabSearch({
  foundation,
  sourceQueryWithinLimit,
  shouldQueryGitlab
}: {
  foundation: Foundation
  sourceQueryWithinLimit: boolean
  shouldQueryGitlab: boolean
}): void {
  const {
    debouncedQuery,
    disabled,
    onGitLabItemSelect,
    mode,
    repoBackedSearchTargets,
    mrStateFilter,
    setGitlabItems,
    setGitlabLoading
  } = foundation
  // Why: the project-internal /-/ separator excludes non-GitLab URLs.
  const parsedGlLink = useMemo(
    () => (sourceQueryWithinLimit ? parseGitLabIssueOrMRLink(debouncedQuery) : null),
    [debouncedQuery, sourceQueryWithinLimit]
  )

  useEffect(() => {
    if (!shouldQueryGitlab || disabled || !onGitLabItemSelect) {
      // Why: the list effect below is the sole writer in GitLab mode without a URL.
      if (!shouldQueryGitlab || (parsedGlLink === null && mode !== 'gitlab')) {
        setGitlabItems([])
      }
      setGitlabLoading(false)
      return
    }
    if (parsedGlLink === null) {
      if (mode !== 'gitlab') {
        setGitlabItems([])
      }
      setGitlabLoading(false)
      return
    }
    let stale = false
    setGitlabLoading(true)
    void Promise.all(
      repoBackedSearchTargets.map((target) =>
        lookupGitLabWorkItemByPathForSource({
          repoPath: target.repo.path,
          repoId: target.repo.id,
          sourceContext: target.gitlabSourceContext,
          // Why: self-hosted URLs resolve against their pasted hostname, not gitlab.com.
          host: parsedGlLink.slug.host,
          path: parsedGlLink.slug.path,
          iid: parsedGlLink.number,
          type: parsedGlLink.type
        }).catch(() => null)
      )
    )
      .then((items) => {
        if (stale) {
          return
        }
        setGitlabItems(items.filter((item): item is GitLabWorkItem => item !== null))
      })
      .catch(() => {
        if (!stale) {
          setGitlabItems([])
        }
      })
      .finally(() => {
        if (!stale) {
          setGitlabLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [
    disabled,
    mode,
    onGitLabItemSelect,
    parsedGlLink,
    repoBackedSearchTargets,
    setGitlabItems,
    setGitlabLoading,
    shouldQueryGitlab
  ])

  // Why: state chips mirror GitLab's default opened-MR list when no URL is pasted.
  useEffect(() => {
    if (!shouldQueryGitlab || disabled || !onGitLabItemSelect) {
      if (!shouldQueryGitlab) {
        setGitlabItems([])
        setGitlabLoading(false)
      }
      return
    }
    if (repoBackedSearchTargets.length === 0) {
      setGitlabItems([])
      setGitlabLoading(false)
      return
    }
    if (parsedGlLink !== null) {
      return
    }
    let stale = false
    setGitlabLoading(true)
    const trimmedQuery = debouncedQuery.trim() || undefined
    // Why: empty-query list must not briefly paint the previous non-empty result set.
    if (trimmedQuery === undefined) {
      setGitlabItems([])
    }
    void Promise.all(
      repoBackedSearchTargets.map((target) =>
        listGitLabMRsForSource({
          repoPath: target.repo.path,
          repoId: target.repo.id,
          sourceContext: target.gitlabSourceContext,
          state: mrStateFilter,
          page: 1,
          perPage: RESULT_LIMIT,
          query: trimmedQuery
        }).catch(() => ({ items: [], hasMore: false }))
      )
    )
      .then((results) => {
        if (stale) {
          return
        }
        setGitlabItems(
          results
            .flatMap((result) => result.items)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, RESULT_LIMIT)
        )
      })
      .catch(() => {
        if (!stale) {
          setGitlabItems([])
        }
      })
      .finally(() => {
        if (!stale) {
          setGitlabLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [
    debouncedQuery,
    disabled,
    mode,
    mrStateFilter,
    onGitLabItemSelect,
    parsedGlLink,
    repoBackedSearchTargets,
    setGitlabItems,
    setGitlabLoading,
    shouldQueryGitlab
  ])
}
