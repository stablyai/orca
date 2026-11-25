import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { normalizeGitHubLinkQuery } from '../../../../../shared/new-workspace/github-links'
import {
  lookupGitHubWorkItemByOwnerRepoForSource,
  lookupGitHubWorkItemForSource
} from '@/lib/work-items/github/github-work-item-source-lookup'
import {
  lookupSmartGitHubNumberItems,
  lookupSmartGitHubSubmitItem
} from '@/lib/work-items/github/smart-github-submit'
import { RESULT_LIMIT } from '../name-field/smart-workspace-name-field-model'
import { resolveSmartWorkspaceGithubDirectLink } from './smart-workspace-github-direct-link'
import type { useWorkItemSourceFoundation } from './use-work-item-source-foundation'

type Foundation = ReturnType<typeof useWorkItemSourceFoundation>

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
    setCrossRepoPrompt
  } = foundation
  const normalizedGhQuery = useMemo(
    () => normalizeGitHubLinkQuery(sourceQueryWithinLimit ? debouncedQuery : ''),
    [debouncedQuery, sourceQueryWithinLimit]
  )

  useEffect(() => {
    if (disabled || !shouldQueryGithub) {
      setCrossRepoPrompt(null)
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
    const { directLink, isIssueShorthand } = normalizedGhQuery
    if (
      directLink &&
      (isIssueShorthand || handledCrossRepoUrlRef.current !== debouncedQuery.trim())
    ) {
      if (isIssueShorthand) {
        setGithubItems([])
      }
      setGithubLoading(true)
      void resolveSmartWorkspaceGithubDirectLink({
        directLink,
        isIssueShorthand,
        crossRepoSwitchTarget,
        repoBackedSearchTargets,
        selectedRepo,
        githubSourceContext,
        repos,
        repoSlugCache: repoSlugCacheRef.current,
        handledCrossRepoUrlRef,
        query: debouncedQuery.trim(),
        isCurrent: () => !stale
      })
        .then((result) => {
          if (stale) {
            return
          }
          setGithubItems(result.items)
          if (result.prompt) {
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
      const intent = directLink
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
        repoBackedSearchTargets.map(async (target) => {
          const lookup = {
            sourceContext: target.githubSourceContext,
            workItem: lookupGitHubWorkItemForSource,
            workItemByOwnerRepo: lookupGitHubWorkItemByOwnerRepoForSource
          }
          if (intent.kind === 'hash-number') {
            return lookupSmartGitHubNumberItems(target.repo, intent.number, lookup)
          }
          const item = await lookupSmartGitHubSubmitItem({
            ...lookup,
            repoPath: target.repo.path,
            repoId: target.repo.id,
            intent
          }).catch(() => null)
          return item ? [item] : []
        })
      ).then((items) =>
        items
          .flat()
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
    // Why: a search held by a pending source save is obsolete, not empty; re-read once it settles, unless cleaned up.
    const controller = new AbortController()
    const readCurrent = <T>(read: () => Promise<T | undefined>) =>
      useAppStore.getState().githubSourceCollections.readCurrent(
        repoBackedSearchTargets.map((target) => target.repo),
        read,
        controller.signal
      )
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
      void readCurrent(() =>
        fetchWorkItems(target.repo.id, target.repo.path, RESULT_LIMIT, query, {
          sourceContext: target.githubSourceContext
        })
      )
        .then((items) => {
          if (!stale && items) {
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
      void readCurrent(() =>
        fetchWorkItemsAcrossRepos(
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
      )
        .then((result) => {
          if (!stale && result) {
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
      controller.abort()
    }
  }, [
    debouncedQuery,
    disabled,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    getCachedWorkItems,
    normalizedGhQuery,
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
    setGithubLoading
  ])
}
