import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CircleDot, Copy, Ellipsis, ExternalLink, MonitorUp, Pencil } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader, MetadataActionIcon } from './WorktreeCardMetadataControls'
import { IssueStateBadge } from './WorktreeCardMetadataStatusBadges'
import type { WorktreeCardIssueDisplay } from './worktree-card-meta-types'

type WorktreeCardIssueDetailSectionProps = {
  issue: WorktreeCardIssueDisplay | null
  issueMenuOpen: boolean
  onIssueMenuOpenChange: (open: boolean) => void
  onCopyIssueLink?: () => void
  onEditIssue?: (event: React.MouseEvent) => void
  onOpenGitHubIssueInOrca?: (event: React.MouseEvent) => void
}

export function WorktreeCardIssueDetailSection({
  issue,
  issueMenuOpen,
  onIssueMenuOpenChange,
  onCopyIssueLink,
  onEditIssue,
  onOpenGitHubIssueInOrca
}: WorktreeCardIssueDetailSectionProps): React.JSX.Element | null {
  if (!issue) {
    return null
  }

  const issueLabels = issue.labels ?? []
  const moreActionsLabel = translate(
    'auto.components.sidebar.WorktreeCardMeta.moreIssueActions',
    'More issue actions'
  )
  const moreActionsTrigger = (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-6"
        aria-label={moreActionsLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <Ellipsis className="size-3" />
      </Button>
    </DropdownMenuTrigger>
  )

  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<CircleDot className="size-3 text-muted-foreground" />}
        label={translate(
          'auto.components.sidebar.WorktreeCardMeta.e97d8f2876',
          'Issue #{{value0}}',
          {
            value0: issue.number
          }
        )}
        actions={
          <>
            {issue.url && onCopyIssueLink && (
              <DropdownMenu modal={false} open={issueMenuOpen} onOpenChange={onIssueMenuOpenChange}>
                {issueMenuOpen ? (
                  moreActionsTrigger
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>{moreActionsTrigger}</TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {moreActionsLabel}
                    </TooltipContent>
                  </Tooltip>
                )}
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onSelect={onCopyIssueLink}>
                    <Copy className="size-3.5" />
                    {translate('auto.components.sidebar.WorktreeCardMeta.copyLink', 'Copy link')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {onEditIssue && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.807b13b9ec',
                  'Edit issue'
                )}
                onClick={onEditIssue}
              >
                <Pencil className="size-3" />
              </MetadataActionIcon>
            )}
            {issue.url && onOpenGitHubIssueInOrca && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.2c67730e07',
                  'Open in Orca'
                )}
                onClick={onOpenGitHubIssueInOrca}
              >
                <MonitorUp className="size-3" />
              </MetadataActionIcon>
            )}
            {issue.url && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.b22f058067',
                  'View on GitHub'
                )}
                href={issue.url}
              >
                <ExternalLink className="size-3" />
              </MetadataActionIcon>
            )}
          </>
        }
      />
      <WorktreeCardDetailSectionContent className="space-y-1.5">
        <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
          {issue.title}
        </div>
        {(issue.state || issueLabels.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {issue.state && <IssueStateBadge state={issue.state} />}
            {issueLabels.map((label) => (
              <Badge key={label} variant="outline" className="h-4 px-1.5 text-[9px]">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}
