import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import type { BundledSkillUnsupportedReason } from '@/runtime/runtime-bundled-skills-client'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { cn } from '@/lib/utils'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import {
  getSkillFreshnessDisplayStatus,
  hasSkillCopyNeedingAttention,
  skillPlanHasDetails,
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
          'Review skill'
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

// Presence alone cannot imply freshness; copies the updater cannot reach need attention instead of green.
export function SkillFreshnessStatusPill({ skillName }: { skillName: string }): React.JSX.Element {
  const { plan, unsupported, loading, error } = useSkillFreshness(
    useActiveProjectSkillRuntime().bundledSkillTarget
  )
  if (unsupported) {
    return <SkillUnsupportedStatusPill reason={unsupported} />
  }
  if (loading && !plan) {
    return (
      <IntegrationStatusPill tone="neutral">
        {translate('auto.components.skills.SkillFreshnessStatusPill.checking', 'Checking...')}
      </IntegrationStatusPill>
    )
  }
  if (error && !plan) {
    return (
      <IntegrationStatusPill tone="attention">
        {translate('auto.components.skills.SkillFreshnessStatusPill.checkFailed', 'Check failed')}
      </IntegrationStatusPill>
    )
  }
  return <SkillPlanStatusPill plan={plan} skillName={skillName} />
}

export function SkillUnsupportedStatusPill({
  reason
}: {
  reason: BundledSkillUnsupportedReason
}): React.JSX.Element {
  return (
    <IntegrationStatusPill tone="neutral">
      {reason === 'connect-host'
        ? translate(
            'auto.components.skills.SkillFreshnessStatusPill.connectHost',
            'Connect the SSH host'
          )
        : translate(
            'auto.components.skills.SkillFreshnessStatusPill.updateServer',
            'Update Orca on the server'
          )}
    </IntegrationStatusPill>
  )
}

export function SkillPlanStatusPill({
  plan,
  skillName,
  target
}: {
  plan: BundledSkillPlan | null
  skillName: string
  target?: BundledSkillTarget | null
}): React.JSX.Element {
  const status = getSkillFreshnessDisplayStatus(plan, skillName)
  const entry = plan?.skills.find((skill) => skill.name === skillName)
  const needsAttention =
    hasSkillCopyNeedingAttention(plan, skillName) ||
    Boolean(
      entry?.ops.some(
        (op) => op.kind === 'leave' && (op.reason === 'edited' || op.reason === 'other')
      )
    )
  // Offer Details for any planned location/action, including adding an agent link.
  const hasDetails = needsAttention || skillPlanHasDetails(plan, skillName)
  return (
    <span className="inline-flex items-center gap-2">
      {statusPill(
        needsAttention
          ? 'needs-attention'
          : status === 'up-to-date' &&
              entry?.ops.some(
                (op) => op.kind === 'write' || op.kind === 'link' || op.kind === 'copy'
              )
            ? 'installed'
            : status
      )}
      {hasDetails ? (
        <Button
          // A ghost button’s hover/focus surface makes Details read as a header control.
          variant="ghost"
          size="xs"
          className={cn(
            'gap-1 px-1.5 text-[11px]',
            needsAttention && 'text-amber-500 hover:text-amber-500'
          )}
          onClick={() => requestSkillFreshnessUpdateDialog(target)}
        >
          {needsAttention ? <AlertTriangle className="size-3" /> : null}
          {translate('auto.components.skills.SkillFreshnessStatusPill.details', 'Details')}
          {/* Point right for dialog navigation; down chevrons disclose content within that dialog. */}
          <ChevronRight className="size-3" />
        </Button>
      ) : null}
    </span>
  )
}
