import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { cn } from '@/lib/utils'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import {
  getSkillFreshnessDisplayStatus,
  hasSkillCopyNeedingAttention,
  type SkillFreshnessDisplayStatus
} from '@/lib/skill-freshness-display-status'
import { requestSkillFreshnessUpdateDialog } from './skill-freshness-update-dialog'

function statusPill(status: SkillFreshnessDisplayStatus): React.JSX.Element {
  if (status === 'update-available') {
    return (
      <IntegrationStatusPill tone="attention">
        {translate(
          'auto.components.skills.SkillFreshnessStatusPill.updateAvailable',
          'Update available'
        )}
      </IntegrationStatusPill>
    )
  }
  if (status === 'needs-attention') {
    return (
      <IntegrationStatusPill tone="attention">
        {translate(
          'auto.components.skills.SkillFreshnessStatusPill.needsAttention',
          'Needs attention'
        )}
      </IntegrationStatusPill>
    )
  }
  if (status === 'up-to-date') {
    return (
      <IntegrationStatusPill tone="connected">
        {translate('auto.components.skills.SkillFreshnessStatusPill.upToDate', 'Up to date')}
      </IntegrationStatusPill>
    )
  }
  return (
    <IntegrationStatusPill tone="connected">
      {translate('auto.components.skills.SkillFreshnessStatusPill.installed', 'Installed')}
    </IntegrationStatusPill>
  )
}

// Why: the setup rails' Installed pill is presence-only. Freshness knows more — that
// a safe update exists, that every copy is current, or that a copy is out of date
// somewhere the update cannot reach — and green must never stand in for that last
// case, which is real drift the user would otherwise have no way to see.
export function SkillFreshnessStatusPill({ skillName }: { skillName: string }): React.JSX.Element {
  const { inventory } = useSkillFreshness()
  const status = getSkillFreshnessDisplayStatus(inventory, skillName)
  // Why: the dialog lists every placement, so Details is offered whenever a placement
  // is what drove the status — an available update, or a copy that blocked one.
  const hasDetails = status === 'update-available' || status === 'needs-attention'
  // Why: the badge alone can't say which copies are wrong, and the reasons only read
  // correctly beside the locations they describe. Marking the way in is enough here —
  // the dialog does the explaining, with every location and cause it knows about.
  const needsAttention = hasSkillCopyNeedingAttention(inventory, skillName)
  return (
    <span className="inline-flex items-center gap-2">
      {statusPill(status)}
      {hasDetails ? (
        <Button
          // Why: ghost, not link — this sits in a header row rather than inside a
          // paragraph, and its hover/focus background is what makes it read as a
          // control. No chevron: it opens the review dialog, and the chevron already
          // means an in-place expander on that dialog's own details section.
          variant="ghost"
          size="xs"
          className={cn(
            'gap-1 px-1.5 text-[11px]',
            needsAttention && 'text-amber-500 hover:text-amber-500'
          )}
          onClick={() => requestSkillFreshnessUpdateDialog()}
        >
          {needsAttention ? <AlertTriangle className="size-3" /> : null}
          {translate('auto.components.skills.SkillFreshnessStatusPill.details', 'Details')}
          {/* Why: a chevron is what makes this read as a control at rest rather than a
              label. It points right, not down — this opens the review dialog, and a
              down chevron already means an in-place expander inside that dialog. */}
          <ChevronRight className="size-3" />
        </Button>
      ) : null}
    </span>
  )
}
