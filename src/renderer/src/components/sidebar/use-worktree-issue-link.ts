import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import { issueCacheKey as getIssueCacheKey } from '@/store/slices/github'
import { useMountedRef } from '@/hooks/useMountedRef'
import { parseExplicitGitHubIssueUrl } from './worktree-meta-updates'

/** Resolves the "open linked issue" affordance for the worktree meta dialog:
 *  explicit URLs open directly, numbers resolve via the issue cache or an
 *  owner-routed fetch. */
export function useWorktreeIssueLink(args: { worktreeId: string; issueInput: string }): {
  canOpenIssue: boolean
  openingIssue: boolean
  handleOpenIssue: () => Promise<void>
  resetOpeningIssue: () => void
} {
  const { worktreeId, issueInput } = args
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const [openingIssue, setOpeningIssue] = useState(false)
  const mountedRef = useMountedRef()

  const issueNumber = useMemo(() => parseGitHubIssueOrPRNumber(issueInput), [issueInput])
  const issueUrlFromInput = useMemo(() => parseExplicitGitHubIssueUrl(issueInput), [issueInput])
  const issueInputLooksLikeUrl = useMemo(
    () => /^https?:\/\//i.test(issueInput.trim()),
    [issueInput]
  )
  const issueRepo = useAppStore((s) => {
    const worktree = Object.values(s.worktreesByRepo)
      .flat()
      .find((item) => item.id === worktreeId)
    if (!worktree) {
      return undefined
    }
    return s.repos.find((repo) => repo.id === worktree.repoId)
  })
  const cachedIssueUrl = useAppStore((s) => {
    if (!issueRepo || issueNumber === null) {
      return null
    }
    return (
      s.issueCache[
        getIssueCacheKey(
          issueRepo.path,
          issueRepo.id,
          issueNumber,
          s.settings,
          issueRepo.connectionId,
          issueRepo.executionHostId
        )
      ]?.data?.url ?? null
    )
  })
  const canOpenIssue = issueInputLooksLikeUrl
    ? Boolean(issueUrlFromInput)
    : Boolean(cachedIssueUrl || (issueRepo && issueNumber))

  const handleOpenIssue = useCallback(async () => {
    if (openingIssue) {
      return
    }

    if (issueUrlFromInput) {
      void window.api.shell.openUrl(issueUrlFromInput)
      return
    }

    if (issueInputLooksLikeUrl) {
      return
    }

    if (cachedIssueUrl) {
      void window.api.shell.openUrl(cachedIssueUrl)
      return
    }

    if (!issueRepo || issueNumber === null) {
      return
    }

    setOpeningIssue(true)
    try {
      const issue = await fetchIssue(issueRepo.path, issueNumber, { repoId: issueRepo.id })
      if (issue?.url) {
        void window.api.shell.openUrl(issue.url)
      }
    } finally {
      if (mountedRef.current) {
        setOpeningIssue(false)
      }
    }
  }, [
    cachedIssueUrl,
    fetchIssue,
    issueInputLooksLikeUrl,
    issueNumber,
    issueRepo,
    issueUrlFromInput,
    mountedRef,
    openingIssue
  ])

  const resetOpeningIssue = useCallback(() => setOpeningIssue(false), [])

  return { canOpenIssue, openingIssue, handleOpenIssue, resetOpeningIssue }
}
