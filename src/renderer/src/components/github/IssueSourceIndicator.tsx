import React from 'react'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../../../shared/github/repository-identity-key'

export type IssueSourceIndicatorProps = {
  /** Null while unresolved or when the repo has no GitHub remote. */
  issues: GitHubOwnerRepo | null
  prs: GitHubOwnerRepo | null
  /** Choose plural list copy or singular item copy; suppression is identical. */
  variant?: 'list' | 'item'
  /** Identify the local repo when multiple repos are in scope; omit for compact single-repo chips. */
  localRepo?: { displayName: string; color: string }
  className?: string
}

// Name the resolved repository, not remote aliases that could imply a stable UI-to-git-config mapping.
function issueSourceTemplate(variant: 'list' | 'item'): string {
  return variant === 'item'
    ? translate('auto.components.github.IssueSourceIndicator.issueFromRepo', 'Issue from <repo/>')
    : translate('auto.components.github.IssueSourceIndicator.issuesFromRepo', 'Issues from <repo/>')
}

export function sameGitHubOwnerRepo(
  left: GitHubOwnerRepo | null,
  right: GitHubOwnerRepo | null
): boolean {
  if (!left || !right) {
    return false
  }
  // Compare case-insensitive slugs within the same GitHub host; GHES and github.com identities differ.
  return githubRepoIdentityKey(left) === githubRepoIdentityKey(right)
}

/** Show the source only when issues and PRs resolve to distinct repositories; hide unresolved sources without a skeleton. */
export default function IssueSourceIndicator({
  issues,
  prs,
  variant = 'list',
  localRepo,
  className
}: IssueSourceIndicatorProps): React.JSX.Element | null {
  if (!issues || !prs) {
    return null
  }
  if (sameGitHubOwnerRepo(issues, prs)) {
    return null
  }
  const host = issues.host?.trim()
  const slug =
    host && !isDefaultGitHubHost(host)
      ? `${host}/${issues.owner}/${issues.repo}`
      : `${issues.owner}/${issues.repo}`
  const template = issueSourceTemplate(variant)
  const label = template.replace('<repo/>', slug)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground',
        className
      )}
      title={localRepo ? `${localRepo.displayName}: ${label}` : label}
    >
      {localRepo ? (
        // Disambiguate which local repo this issue-source chip describes in multi-repo views.
        <RepoBadgeLabel
          name={localRepo.displayName}
          color={localRepo.color}
          badgeClassName="size-1.5"
          className="text-[10px] text-muted-foreground"
        />
      ) : null}
      <span>
        <Trans
          i18n={i18n}
          defaults={template}
          components={{
            repo: <span className="font-mono text-foreground/80">{slug}</span>
          }}
        />
      </span>
    </span>
  )
}
