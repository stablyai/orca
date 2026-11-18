import { useMemo } from 'react'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/repositories/links'
import { githubRepoIdentityKey } from '../../../../shared/github/repositories/repository-identity-key'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getGitHubWorkItemRowHostId } from '@/store/github/work-items/work-item-routing'
import type { GitHubWorkItem } from '../../../../shared/github/work-items/work-item-types'

// Reuse the empty result to avoid allocating on every store write while the picker is closed.
const NO_DUPLICATE_CANDIDATES: readonly GitHubWorkItem[] = []

export function useGitHubDuplicateIssueCandidates(
  item: Pick<GitHubWorkItem, 'repoId' | 'number' | 'url' | 'repoHostId'>,
  pickerOpen: boolean
): readonly GitHubWorkItem[] {
  const { repoId, number, url, repoHostId } = item
  const select = useMemo(() => {
    let last: { cache?: AppState['workItemsCache']; repos?: AppState['repos'] } = {}
    let result = NO_DUPLICATE_CANDIDATES
    return (s: AppState) => {
      if (!pickerOpen) {
        return NO_DUPLICATE_CANDIDATES
      }
      if (last.cache === s.workItemsCache && last.repos === s.repos) {
        return result
      }
      last = { cache: s.workItemsCache, repos: s.repos }
      // Why resolve: New Issue's created row has no host stamp; its registered row still names one.
      const hostOf = (row: Pick<GitHubWorkItem, 'repoId' | 'repoHostId'>) =>
        row.repoHostId ?? getGitHubWorkItemRowHostId(s, row.repoId, '')
      const host = hostOf({ repoId, repoHostId })
      const repository = parseGitHubIssueOrPRLink(url)?.slug
      const repositoryKey = repository && githubRepoIdentityKey(repository)
      const deduped = new Map<number, GitHubWorkItem>()
      for (const entry of repositoryKey ? Object.values(s.workItemsCache) : []) {
        for (const candidate of entry.data ?? []) {
          // Cheap identity checks first so other repos' rows never pay for URL parsing.
          if (
            candidate.type === 'issue' &&
            candidate.repoId === repoId &&
            candidate.number !== number &&
            !deduped.has(candidate.number) &&
            hostOf(candidate) === host &&
            (() => {
              const slug = parseGitHubIssueOrPRLink(candidate.url)?.slug
              return slug && githubRepoIdentityKey(slug) === repositoryKey
            })()
          ) {
            deduped.set(candidate.number, candidate)
          }
        }
      }
      result = Array.from(deduped.values()).sort((a, b) => b.number - a.number)
      return result
    }
  }, [pickerOpen, repoId, number, url, repoHostId])
  return useAppStore(useShallow(select))
}
