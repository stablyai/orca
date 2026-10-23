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

// Why: the setup rails' Installed pill is presence-only. The plan knows more — that an
// update exists, that every copy is current, or that a copy is left for the user — and
// green must never stand in for that last case.
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
  // Why: the dialog lists every location and what the update does there, so Details is
  // offered whenever the plan has anything for this skill, including an agent to link.
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
          onClick={() => requestSkillFreshnessUpdateDialog(target)}
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
