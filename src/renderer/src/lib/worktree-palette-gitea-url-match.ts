import type { HostedReviewInfo } from '../../../shared/hosted-review'
import {
  parseGiteaIssueOrPRLink,
  type GiteaIssueOrPRLink
} from '../../../shared/new-workspace/gitea-links'
import type { Repo } from '../../../shared/repo-types'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments'
import type { Worktree } from '../../../shared/worktree/types'
import { getPaletteWorktreeExecutionHostId } from './palette-repo-resolution'
import type { PaletteSearchResult } from './worktree-palette-search'
import type { CmdJTaskUrlCreatePreview } from './worktree-palette-task-url-preview'
import { buildWorktreePaletteTaskUrlResult } from './worktree-palette-task-url-result'

export function getGiteaTaskUrlCreatePreview(link: GiteaIssueOrPRLink): CmdJTaskUrlCreatePreview {
  const { slug, number, type } = link
  const project = `${slug.host}/${slug.path}`
  const kindLabel = type === 'pr' ? 'Gitea pull request' : 'Gitea issue'
  return {
    provider: 'gitea',
    identifier: `#${number}`,
    subtitle: project,
    kindLabel,
    createLabel: `Create worktree from ${kindLabel} ${project}#${number}`
  }
}

function giteaLinksEqual(left: GiteaIssueOrPRLink, right: GiteaIssueOrPRLink): boolean {
  return (
    left.type === right.type &&
    left.number === right.number &&
    left.slug.host.toLowerCase() === right.slug.host.toLowerCase() &&
    left.slug.path.toLowerCase() === right.slug.path.toLowerCase()
  )
}

/** Tri-state: `'unknown'` (no resolved remote identity) stays permissive for bare numbers. */
function repoMatchesGiteaSlug(
  repo: Repo | undefined,
  slug: GiteaIssueOrPRLink['slug']
): boolean | 'unknown' {
  const key = repo?.gitRemoteIdentity?.canonicalKey
  if (!key) {
    return 'unknown'
  }
  return key.toLowerCase() === `${slug.host}/${slug.path}`.toLowerCase()
}

function worktreeMatchesGiteaUrl(
  worktree: Worktree,
  link: GiteaIssueOrPRLink,
  repo: Repo | undefined,
  review: HostedReviewInfo | null | undefined
): boolean {
  const attached = getWorkspaceAttachments(worktree)
    .filter((item) => item.provider === 'gitea')
    .some((item) => {
      const itemUrl = item.url ? parseGiteaIssueOrPRLink(item.url, { assumeGitea: true }) : null
      if (itemUrl) {
        return giteaLinksEqual(itemUrl, link)
      }
      return (
        item.type === link.type &&
        item.number === link.number &&
        repoMatchesGiteaSlug(repo, link.slug) !== false
      )
    })
  const reviewUrl =
    review?.provider === 'gitea' && review.url
      ? parseGiteaIssueOrPRLink(review.url, { assumeGitea: true })
      : null
  return attached || Boolean(reviewUrl && giteaLinksEqual(reviewUrl, link))
}

export function matchGiteaWorktreePaletteTaskUrl(args: {
  worktree: Worktree
  link: GiteaIssueOrPRLink
  repo?: Repo
  review?: HostedReviewInfo | null
}): PaletteSearchResult | null {
  const { worktree, link, repo, review } = args
  if (!worktreeMatchesGiteaUrl(worktree, link, repo, review)) {
    return null
  }
  const worktreeHostId = getPaletteWorktreeExecutionHostId(worktree)
  return buildWorktreePaletteTaskUrlResult({
    worktreeId: worktree.id,
    ...(worktreeHostId ? { worktreeHostId } : {}),
    labelKind: link.type === 'pr' ? 'pr' : 'issue',
    text: `${link.type === 'pr' ? 'PR' : 'Issue'} #${link.number}`
  })
}
