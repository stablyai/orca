import { Badge } from '@/components/ui/badge'
import { ExternalLink, MonitorUp } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { OdooIcon } from '@/components/icons/OdooIcon'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader, MetadataActionIcon } from './WorktreeCardMetadataControls'
import type { WorktreeCardOdooTicketDisplay } from './worktree-card-meta-types'

type WorktreeCardOdooDetailSectionProps = {
  odooTicket: WorktreeCardOdooTicketDisplay | null
  // Pre-wrapped (dismiss-and-run) by the caller, mirroring the issue section.
  onOpenOdooTicketInOrca?: (event: React.MouseEvent) => void
}

export function WorktreeCardOdooDetailSection({
  odooTicket,
  onOpenOdooTicketInOrca
}: WorktreeCardOdooDetailSectionProps): React.JSX.Element | null {
  if (!odooTicket) {
    return null
  }

  const labels = odooTicket.labels ?? []

  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<OdooIcon className="size-3 text-muted-foreground" />}
        label={translate(
          'auto.components.sidebar.WorktreeCardMeta.odooTicketDetail',
          'Odoo ticket {{value0}}',
          { value0: odooTicket.ref }
        )}
        actions={
          <>
            {odooTicket.url && onOpenOdooTicketInOrca && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.2c67730e07',
                  'Open in Orca'
                )}
                onClick={onOpenOdooTicketInOrca}
              >
                <MonitorUp className="size-3" />
              </MetadataActionIcon>
            )}
            {odooTicket.url && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.odooTicketView',
                  'View on Odoo'
                )}
                href={odooTicket.url}
              >
                <ExternalLink className="size-3" />
              </MetadataActionIcon>
            )}
          </>
        }
      />
      <WorktreeCardDetailSectionContent className="space-y-1.5">
        <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
          {odooTicket.title}
        </div>
        {(odooTicket.stageName || labels.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {odooTicket.stageName && (
              <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                {odooTicket.stageName}
              </Badge>
            )}
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
