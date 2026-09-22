import { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import { issueCacheKey as getIssueCacheKey } from '@/store/github/cache-identity'
import { useMountedRef } from '@/hooks/useMountedRef'
import { findIndexedWorktreeOwner } from '@/lib/worktree-runtime-owner-index'
import { buildLinearIssueUrl, parseLinearIssueInput } from '../../../../shared/linear/links'
import {
  getIssueLinkProviderFromUrl,
  type IssueLinkProvider
} from '../../../../shared/issue-link-input'
import { parseBareItemNumber } from '../../../../shared/work-item-number'
import type { WorkspaceLinkedItem } from '../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { parseExplicitGitHubIssueUrl } from './worktree-meta-updates'
import { isWorkItemLinkQueryTooLarge } from '../../../../shared/new-workspace/work-item-link-query-bounds'

// Why: both lookups cross an IPC or runtime-RPC boundary that can stop
// answering — a hung SSH runtime leaves the await pending, and the button spins
// for the life of the dialog. Set above the 30s Linear/GitHub client bounds, so a
// slow-but-live transport reports its own failure rather than being called a bad
// identifier here.
const OPEN_ISSUE_TIMEOUT_MS = 35_000

async function resolveIssueUrlWithinTimeout(
  lookup: Promise<{ url?: string } | null>
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const issue = await Promise.race([
      lookup,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), OPEN_ISSUE_TIMEOUT_MS)
      })
    ])
    return issue?.url ?? null
  } catch {
    // Why: the store's fetchers already log and normalize failures to null; a
    // rejection here is a transport fault and reads the same to the user.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves the "open linked issue" affordance for the worktree meta dialog:
 *  explicit URLs open directly, GitHub numbers resolve via the issue cache or an
 *  owner-routed fetch, Linear identifiers via the stored org key or a lookup. */
export function useWorktreeIssueLink(args: {
  worktreeId: string
  /** The repo bucket the opening row belongs to, for IDs the owner index reports
   *  as ambiguous across hosts. Falls back to the index when absent. */
  ownerRepoId?: string | null
  issueInput: string
  issueProvider: IssueLinkProvider
  linearOrganizationUrlKey?: string | null
  /** The persisted identifier the stored org key belongs to. */
  linkedLinearIssue?: string | null
  linearSourceContext?: TaskSourceContext | null
  /** Recorded at workspace creation: the only URL a GitLab issue link ever has. */
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedGitLabIssue?: number | null
}): {
  canOpenIssue: boolean
  openingIssue: boolean
  /** A lookup came back empty: wrong identifier, no access, or provider offline. */
  openIssueFailed: boolean
  handleOpenIssue: () => Promise<void>
  resetOpeningIssue: () => void
} {
  const {
    worktreeId,
    ownerRepoId,
    issueInput,
    issueProvider,
    linearOrganizationUrlKey,
    linkedLinearIssue,
    linearSourceContext,
    linkedWorkItem,
    linkedGitLabIssue
  } = args
  const isLinear = issueProvider === 'linear'
  const isGitLab = issueProvider === 'gitlab'
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const [openingIssue, setOpeningIssue] = useState(false)
  const [failedIssueInput, setFailedIssueInput] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  // Why: the field stays editable while a lookup is in flight, and Promise.race
  // cannot cancel the losing promise. A result that lands after the value moved
  // on — or after a reset — must not open the issue the user just replaced.
  const openRequestRef = useRef(0)
  const latestRequestKeyRef = useRef('')
  latestRequestKeyRef.current = `${issueProvider}\u0000${issueInput}`

  // Why: `matchGitHubItemPath` strips trailing slashes with an unanchored `/\/+$/`,
  // which is quadratic — a 160 KB paste of slashes freezes the renderer for ~19s.
  // These parses run on every keystroke, so they get the same bound the save gate
  // applies. The check short-circuits on length, so it stays O(1) on a huge paste.
  const boundedInput = useMemo(
    () => (isWorkItemLinkQueryTooLarge(issueInput) ? '' : issueInput),
    [issueInput]
  )

  // Why: GitHub-only. A GitLab value must never fall into the GitHub number
  // lookup or read the GitHub issue cache.
  const isGitHub = issueProvider === 'github'
  const issueNumber = useMemo(
    () => (isGitHub ? parseGitHubIssueOrPRNumber(boundedInput) : null),
    [isGitHub, boundedInput]
  )
  const issueUrlFromInput = useMemo(
    () => (isGitHub ? parseExplicitGitHubIssueUrl(boundedInput) : null),
    [isGitHub, boundedInput]
  )
  const issueInputLooksLikeUrl = useMemo(
    () => /^https?:\/\//i.test(boundedInput.trim()),
    [boundedInput]
  )
  const parsedLinearIssue = useMemo(
    () => (isLinear ? parseLinearIssueInput(boundedInput) : null),
    [isLinear, boundedInput]
  )
  // Why: only an org key that is authoritative *for this identifier* may build a
  // URL directly — the input's own, or the workspace's stored one while the typed
  // identifier still is that issue. The connected viewer's key is not: a bare key
  // for another of the user's Linear workspaces would open a not-found page, or a
  // different issue on a team-prefix collision. Anything else falls through to the
  // all-workspace lookup below, which answers with the issue's canonical URL.
  const linearIssueUrl = useMemo(() => {
    if (!parsedLinearIssue) {
      return null
    }
    const storedKeyApplies =
      typeof linkedLinearIssue === 'string' &&
      linkedLinearIssue.toUpperCase() === parsedLinearIssue.identifier.toUpperCase()
    return buildLinearIssueUrl({
      identifier: parsedLinearIssue.identifier,
      organizationUrlKey:
        parsedLinearIssue.organizationUrlKey ?? (storedKeyApplies ? linearOrganizationUrlKey : null)
    })
  }, [parsedLinearIssue, linkedLinearIssue, linearOrganizationUrlKey])

  // Why: a GitLab issue is stored as a bare iid with no project path, so the only
  // URL that exists is the one recorded when the workspace was created. Nothing
  // new is persisted to close that gap — the arrow degrades instead.
  const gitLabIssueUrl = useMemo(() => {
    if (!isGitLab) {
      return null
    }
    const trimmed = boundedInput.trim()
    // A pasted URL opens itself, never a stored URL it happens to share a number
    // with. getIssueLinkProviderFromUrl carries the `^https?://` gate, so a
    // GitLab-shaped ftp:// URL never reaches shell.openUrl.
    if (getIssueLinkProviderFromUrl(trimmed) === 'gitlab') {
      return trimmed
    }
    const number = parseBareItemNumber(trimmed)
    return number !== null &&
      number === linkedGitLabIssue &&
      linkedWorkItem?.provider === 'gitlab' &&
      linkedWorkItem.type === 'issue' &&
      linkedWorkItem.number === number
      ? (linkedWorkItem.url ?? null)
      : null
  }, [boundedInput, isGitLab, linkedGitLabIssue, linkedWorkItem])

  const issueRepo = useAppStore((s) => {
    const repoId = ownerRepoId ?? findIndexedWorktreeOwner(s.worktreesByRepo, worktreeId)?.repoId
    return repoId ? s.repos.find((repo) => repo.id === repoId) : undefined
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
          issueRepo.executionHostId,
          true
        )
      ]?.data?.url ?? null
    )
  })
  const canOpenIssue = isGitLab
    ? gitLabIssueUrl !== null
    : isLinear
      ? Boolean(parsedLinearIssue)
      : issueInputLooksLikeUrl
        ? Boolean(issueUrlFromInput)
        : Boolean(cachedIssueUrl || (issueRepo && issueNumber))

  const handleOpenIssue = useCallback(async () => {
    if (openingIssue) {
      return
    }
    setFailedIssueInput(null)
    const generation = ++openRequestRef.current
    const requestKey = latestRequestKeyRef.current
    // Why: the losing side of the timeout race keeps running, so every result
    // has to prove it still belongs to the field the user is looking at.
    const isCurrentRequest = (): boolean =>
      mountedRef.current &&
      openRequestRef.current === generation &&
      latestRequestKeyRef.current === requestKey

    // No async lookup and no spinner — there is nothing to fetch.
    if (isGitLab) {
      if (gitLabIssueUrl) {
        void window.api.shell.openUrl(gitLabIssueUrl)
      }
      return
    }

    if (isLinear) {
      if (!parsedLinearIssue) {
        return
      }
      if (linearIssueUrl) {
        void window.api.shell.openUrl(linearIssueUrl)
        return
      }

      setOpeningIssue(true)
      try {
        // Why: 'all' — the issue may belong to a different Linear workspace than
        // the selected one, which is the usual case for a bare or pasted identifier.
        const url = await resolveIssueUrlWithinTimeout(
          fetchLinearIssue(parsedLinearIssue.identifier, 'all', {
            sourceContext: linearSourceContext ?? null
          })
        )
        if (!isCurrentRequest()) {
          return
        }
        if (url) {
          void window.api.shell.openUrl(url)
        } else {
          // Why: the fetchers normalize every failure — no Linear connection,
          // unknown identifier, dead runtime — to null, so without this the
          // button just stops spinning and the click looks ignored.
          setFailedIssueInput(issueInput)
        }
      } finally {
        if (mountedRef.current) {
          setOpeningIssue(false)
        }
      }
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
      const url = await resolveIssueUrlWithinTimeout(
        fetchIssue(issueRepo.path, issueNumber, { repoId: issueRepo.id })
      )
      if (!isCurrentRequest()) {
        return
      }
      if (url) {
        void window.api.shell.openUrl(url)
      } else {
        setFailedIssueInput(issueInput)
      }
    } finally {
      if (mountedRef.current) {
        setOpeningIssue(false)
      }
    }
  }, [
    cachedIssueUrl,
    fetchIssue,
    fetchLinearIssue,
    gitLabIssueUrl,
    isGitLab,
    isLinear,
    issueInput,
    issueInputLooksLikeUrl,
    issueNumber,
    issueRepo,
    issueUrlFromInput,
    linearIssueUrl,
    linearSourceContext,
    mountedRef,
    openingIssue,
    parsedLinearIssue
  ])

  const resetOpeningIssue = useCallback(() => {
    // Bumping the generation retires any in-flight lookup: a reset means this is
    // a fresh dialog session, and the old result must not open or report here.
    openRequestRef.current += 1
    setOpeningIssue(false)
    setFailedIssueInput(null)
  }, [])

  return {
    canOpenIssue,
    openingIssue,
    // Why: the failure belongs to the value that produced it. Editing the field
    // is the user's answer to it, so comparing rather than clearing on change
    // retires the notice without an Effect that would lag a keystroke behind.
    openIssueFailed: failedIssueInput !== null && failedIssueInput === issueInput,
    handleOpenIssue,
    resetOpeningIssue
  }
}
