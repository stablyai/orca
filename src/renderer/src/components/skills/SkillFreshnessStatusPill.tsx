import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import type { BundledSkillUnsupportedReason } from '@/runtime/skills/bundled/runtime-bundled-skills-client'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { cn } from '@/lib/utils'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import {
  getSkillFreshnessDisplayStatus,
  hasSkillCopyNeedingAttention,
  skillPlanHasDetails,
  type SkillFreshnessDisplayStatus
} from '@/lib/skills/presentation/skill-freshness-display-status'
import { requestSkillFreshnessUpdateDialog } from './skill-freshness-update-dialog'

function statusPill(
  status: SkillFreshnessDisplayStatus,
  t: Translate = translate
): React.JSX.Element {
  if (status === 'update-available') {
    return (
      <IntegrationStatusPill tone="attention">
        {t('auto.components.skills.SkillFreshnessStatusPill.updateAvailable', 'Update available')}
      </IntegrationStatusPill>
    )
  }
  if (status === 'needs-attention') {
    return (
      <IntegrationStatusPill tone="attention">
        {t('auto.components.skills.SkillFreshnessStatusPill.needsAttention', 'Review skill')}
      </IntegrationStatusPill>
    )
  }
  if (status === 'up-to-date') {
    return (
      <IntegrationStatusPill tone="connected">
        {t('auto.components.skills.SkillFreshnessStatusPill.upToDate', 'Up to date')}
      </IntegrationStatusPill>
    )
  }
  return (
    <IntegrationStatusPill tone="connected">
      {t('auto.components.skills.SkillFreshnessStatusPill.installed', 'Installed')}
    </IntegrationStatusPill>
  )
}

// Presence alone cannot imply freshness; copies the updater cannot reach need attention instead of green.
export function SkillFreshnessStatusPill({
  skillName,
  hideCurrent = false
}: {
  skillName: string
  hideCurrent?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { plan, unsupported, loading, error } = useSkillFreshness(
    useActiveProjectSkillRuntime().bundledSkillTarget
  )
  if (unsupported) {
    return <SkillUnsupportedStatusPill reason={unsupported} />
  }
  if (loading && !plan) {
    return (
      <IntegrationStatusPill tone="neutral">
        {t('auto.components.skills.SkillFreshnessStatusPill.checking', 'Checking...')}
      </IntegrationStatusPill>
    )
  }
  if (error && !plan) {
    return (
      <IntegrationStatusPill tone="attention">
        {t('auto.components.skills.SkillFreshnessStatusPill.checkFailed', 'Check failed')}
      </IntegrationStatusPill>
    )
  }
  if (hideCurrent && !skillPlanHasDetails(plan, skillName)) {
    return null
  }
  return <SkillPlanStatusPill plan={plan} skillName={skillName} />
}

export function SkillUnsupportedStatusPill({
  reason
}: {
  reason: BundledSkillUnsupportedReason
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <IntegrationStatusPill tone="neutral">
      {reason === 'connect-host'
        ? t('auto.components.skills.SkillFreshnessStatusPill.connectHost', 'Connect the SSH host')
        : t(
            'auto.components.skills.SkillFreshnessStatusPill.updateServer',
            'Update Orca on the server'
          )}
    </IntegrationStatusPill>
  )
}

export function SkillPlanStatusPill({
  plan,
  skillName,
  target,
  installed = true
}: {
  plan: BundledSkillPlan | null
  skillName: string
  target?: BundledSkillTarget | null
  installed?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const status = getSkillFreshnessDisplayStatus(plan, skillName)
  const entry = plan?.skills.find((skill) => skill.name === skillName)
  const needsAttention = hasSkillCopyNeedingAttention(plan, skillName)
  // Details reviews installed copies; pending installs use the panel's Install action.
  const hasDetails = needsAttention || (installed && skillPlanHasDetails(plan, skillName))
  return (
    <span className="inline-flex items-center gap-2">
      {!needsAttention && !installed ? (
        <IntegrationStatusPill tone="attention">
          {t('auto.components.settings.AgentSkillSetupPanel.5289300939', 'Not installed')}
        </IntegrationStatusPill>
      ) : (
        statusPill(
          needsAttention
            ? 'needs-attention'
            : status === 'up-to-date' &&
                entry?.ops.some(
                  (op) => op.kind === 'write' || op.kind === 'link' || op.kind === 'copy'
                )
              ? 'installed'
              : status,
          t
        )
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
          {t('auto.components.skills.SkillFreshnessStatusPill.details', 'Details')}
          {/* Point right for dialog navigation; down chevrons disclose content within that dialog. */}
          <ChevronRight className="size-3" />
        </Button>
      ) : null}
    </span>
  )
}
