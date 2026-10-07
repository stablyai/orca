import React from 'react'
import { ExternalLink, FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openHttpLink } from '@/lib/http-link-routing'
import type {
  LineageMember,
  LineageMemberPullRequest
} from '../../../../../shared/lineage-discovery-types'
import { LineageOriginBadge } from '../lineage-origin-badge'
import { translate } from '@/i18n/i18n'

export function lineagePullRequestNumberLabel(pr: LineageMemberPullRequest): string {
  return pr.provider === 'gitlab' ? `!${pr.number}` : `#${pr.number}`
}

export function lineagePullRequestLabel(member: LineageMember): string {
  if (member.pr) {
    return `${member.repoName}${lineagePullRequestNumberLabel(member.pr)}`
  }
  if (member.branch) {
    return `${member.repoName} (${member.branch})`
  }
  // why: a manual worktree link whose worktree is gone has only its path left to name it
  const folder = member.worktreePath
    ?.replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
  return folder ? `${member.repoName} (${folder})` : member.repoName
}

/** Compact row for a member with no local worktree (a manual PR or branch not checked out): only a link. */
export function LineagePullRequestRow({
  member,
  testId,
  trailing
}: {
  member: LineageMember
  testId: string
  /** Extra controls placed before the open-link button. */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const label = lineagePullRequestLabel(member)
  const url = member.pr?.url
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs" data-testid={testId}>
      <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-foreground" title={label}>
        {member.pr?.title ?? label}
      </span>
      <LineageOriginBadge matchedBy={member.matchedBy} reasons={member.reasons} />
      <div className="flex-1" />
      {trailing}
      {url ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'auto.components.rightSidebar.lineageChecks.openLabel',
            'Open {{label}}',
            { label }
          )}
          title={translate(
            'auto.components.rightSidebar.lineageChecks.openLabel',
            'Open {{label}}',
            { label }
          )}
          onClick={() => openHttpLink(url)}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
