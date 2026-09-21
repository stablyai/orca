import { useEffect, useMemo } from 'react'
import { normalizeGitHubLinkQuery, parseGitHubIssueOrPRLink } from '@/lib/github-links'
import {
  lookupGitHubWorkItemByOwnerRepoForSource,
  lookupGitHubWorkItemForSource
} from '@/lib/github-work-item-source-lookup'
import { lookupSmartGitHubSubmitItem } from '@/lib/smart-github-submit'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
import { resolveSmartWorkspaceGithubDirectLink } from './smart-workspace-github-direct-link'
import type { useSmartWorkspaceNameFieldFoundation } from './use-smart-workspace-name-field-foundation'

type Foundation = ReturnType<typeof useSmartWorkspaceNameFieldFoundation>

export function useSmartWorkspaceGithubSearch({
  foundation,
  sourceQueryWithinLimit,
  shouldQueryGithub
}: {
  foundation: Foundation
  sourceQueryWithinLimit: boolean
  shouldQueryGithub: boolean
}): void {
  const {
    debouncedQuery,
    disabled,
    handledCrossRepoUrlRef,
    repoSlugCacheRef,
    crossRepoSwitchTarget,
    repoBackedSearchTargets,
    selectedRepo,
    githubSourceContext,
    repos,
    getCachedWorkItems,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    setGithubItems,
    setGithubLoading,
    setOpen,
    setCrossRepoPrompt
  } = foundation
  const normalizedGhQuery = useMemo(
    () => normalizeGitHubLinkQuery(sourceQueryWithinLimit ? debouncedQuery : ''),
    [debouncedQuery, sourceQueryWithinLimit]
  )
  const parsedGhLink = useMemo(
    () => (sourceQueryWithinLimit ? parseGitHubIssueOrPRLink(debouncedQuery) : null),
    [debouncedQuery, sourceQueryWithinLimit]
  )

  useEffect(() => {
    if (disabled || !shouldQueryGithub) {
      setGithubItems([])
      setGithubLoading(false)
      return
    }
    let stale = false
    // Why: clearing the field must not briefly paint the previous non-empty results.
    if (debouncedQuery.trim() === '') {
      setGithubItems([])
    }
    const directNumber = normalizedGhQuery.directNumber
    const directLink = parsedGhLink
    if (directLink !== null && handledCrossRepoUrlRef.current !== debouncedQuery.trim()) {
      setGithubLoading(true)
      void resolveSmartWorkspaceGithubDirectLink({
        directLink,
        crossRepoSwitchTarget,
        repoBackedSearchTargets,
        selectedRepo,
        githubSourceContext,
        repos,
        repoSlugCache: repoSlugCacheRef.current,
        handledCrossRepoUrlRef,
        query: debouncedQuery.trim()
      })
        .then((result) => {
          if (stale) {
            return
          }
          setGithubItems(result.items)
          if (result.prompt) {
            setOpen(false)
            setCrossRepoPrompt(result.prompt)
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
      return () => {
        stale = true
      }
    }
    if (directNumber !== null) {
      setGithubLoading(true)
      const intent =
        directLink !== null
          ? {
              kind: 'link' as const,
              owner: directLink.slug.owner,
              repo: directLink.slug.repo,
              ...(directLink.slug.host ? { host: directLink.slug.host } : {}),
              number: directLink.number,
              type: directLink.type
            }
          : { kind: 'hash-number' as const, number: directNumber }
      const request = Promise.all(
        repoBackedSearchTargets.map((target) =>
          lookupSmartGitHubSubmitItem({
            repoPath: target.repo.path,
            repoId: target.repo.id,
            sourceContext: target.githubSourceContext,
            intent,
            workItem: lookupGitHubWorkItemForSource,
            workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
          }).catch(() => null)
        )
      ).then((items) =>
        items
          .filter((item): item is GitHubWorkItem => item !== null)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, RESULT_LIMIT)
      )
      void request
        .then((items) => {
          if (!stale) {
            setGithubItems(items)
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
      return () => {
        stale = true
      }
    }

    const trimmed = normalizedGhQuery.query.trim()
    const query = trimmed ? normalizedGhQuery.query : ''
    if (repoBackedSearchTargets.length === 1) {
      const target = repoBackedSearchTargets[0]
      const cached = getCachedWorkItems(
        target.repo.id,
        RESULT_LIMIT,
        query,
        target.repo.path,
        target.githubSourceContext
      )
      if (cached) {
        setGithubItems(cached.slice(0, RESULT_LIMIT))
        setGithubLoading(false)
      } else {
        setGithubLoading(true)
      }
      void fetchWorkItems(target.repo.id, target.repo.path, RESULT_LIMIT, query, {
        sourceContext: target.githubSourceContext
      })
        .then((items) => {
          if (!stale) {
            setGithubItems(items.slice(0, RESULT_LIMIT))
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
    } else {
      setGithubLoading(true)
      void fetchWorkItemsAcrossRepos(
        repoBackedSearchTargets.map((target) => ({
          repoId: target.repo.id,
          path: target.repo.path,
          executionHostId: target.repo.executionHostId,
          sourceContext: target.githubSourceContext
        })),
        RESULT_LIMIT,
        RESULT_LIMIT,
        query
      )
        .then((result) => {
          if (!stale) {
            setGithubItems(result.items)
          }
        })
        .catch(() => {
          if (!stale) {
            setGithubItems([])
          }
        })
        .finally(() => {
          if (!stale) {
            setGithubLoading(false)
          }
        })
    }
    return () => {
      stale = true
    }
  }, [
    debouncedQuery,
    disabled,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    getCachedWorkItems,
    normalizedGhQuery,
    parsedGhLink,
    repos,
    repoBackedSearchTargets,
    githubSourceContext,
    selectedRepo,
    crossRepoSwitchTarget,
    shouldQueryGithub,
    handledCrossRepoUrlRef,
    repoSlugCacheRef,
    setCrossRepoPrompt,
    setGithubItems,
    setGithubLoading,
    setOpen
  ])
}
