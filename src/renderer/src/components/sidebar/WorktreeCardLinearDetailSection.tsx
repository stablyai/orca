import { Badge } from '@/components/ui/badge'
import { ExternalLink, MonitorUp } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { LinearIcon } from '@/components/icons/LinearIcon'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader, MetadataActionIcon } from './WorktreeCardMetadataControls'
import { LinearStateBadge } from './WorktreeCardMetadataStatusBadges'
import type { WorktreeCardLinearIssueDisplay } from './worktree-card-meta-types'

type WorktreeCardLinearDetailSectionProps = {
  linearIssue: WorktreeCardLinearIssueDisplay | null
  // Pre-wrapped (dismiss-and-run) by the caller, mirroring the issue section.
  onOpenLinearIssueInOrca?: (event: React.MouseEvent) => void
}

export function WorktreeCardLinearDetailSection({
  linearIssue,
  onOpenLinearIssueInOrca
}: WorktreeCardLinearDetailSectionProps): React.JSX.Element | null {
  if (!linearIssue) {
    return null
  }

  const labels = linearIssue.labels ?? []

  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<LinearIcon className="size-3 text-muted-foreground" />}
        label={translate(
          'auto.components.sidebar.WorktreeCardMeta.5e982e6128',
          'Linear {{value0}}',
          { value0: linearIssue.identifier }
        )}
        actions={
          <>
            {linearIssue.url && onOpenLinearIssueInOrca && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.2c67730e07',
                  'Open in Orca'
                )}
                onClick={onOpenLinearIssueInOrca}
              >
                <MonitorUp className="size-3" />
              </MetadataActionIcon>
            )}
            {linearIssue.url && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.e42941631a',
                  'View on Linear'
                )}
                href={linearIssue.url}
              >
                <ExternalLink className="size-3" />
              </MetadataActionIcon>
            )}
          </>
        }
      />
      <WorktreeCardDetailSectionContent className="space-y-1.5">
        <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
          {linearIssue.title}
        </div>
        {(labels.length > 0 || linearIssue.stateName) && (
          <div className="flex flex-wrap gap-1">
            {linearIssue.stateName && <LinearStateBadge stateName={linearIssue.stateName} />}
            {labels.map((label) => (
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
