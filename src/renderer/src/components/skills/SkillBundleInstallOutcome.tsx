import { AlertTriangle, Check } from 'lucide-react'
import type { SkillBundleInstallResult } from '../../../../shared/skill-bundle-install-contract'
import { translate } from '@/i18n/i18n'

const RESULT_GROUPS = [
  'installed',
  'updated',
  'unchanged',
  'kept-local',
  'failed',
  'cancelled'
] as const

function resultGroupLabel(status: (typeof RESULT_GROUPS)[number]): string {
  const labels = {
    installed: translate(
      'auto.components.skills.SkillBundleInstallOutcome.01c5a12e01',
      'Installed'
    ),
    updated: translate('auto.components.skills.SkillBundleInstallOutcome.01c5a12e02', 'Updated'),
    unchanged: translate(
      'auto.components.skills.SkillBundleInstallOutcome.01c5a12e03',
      'Unchanged'
    ),
    'kept-local': translate(
      'auto.components.skills.SkillBundleInstallOutcome.01c5a12e04',
      'Kept local'
    ),
    failed: translate('auto.components.skills.SkillBundleInstallOutcome.01c5a12e05', 'Failed'),
    cancelled: translate('auto.components.skills.SkillBundleInstallOutcome.01c5a12e06', 'Cancelled')
  }
  return labels[status]
}

export function SkillBundleInstallOutcome({
  result
}: {
  result: SkillBundleInstallResult
}): React.JSX.Element {
  const incomplete = result.status !== 'complete'
  return (
    <div className="space-y-3">
      <div
        className="flex items-center gap-3 rounded-md border border-border p-3"
        role="status"
        aria-live="polite"
      >
        <div className="flex size-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          {incomplete ? <AlertTriangle className="size-4" /> : <Check className="size-4" />}
        </div>
        <div>
          <p className="text-sm font-medium">
            {incomplete
              ? translate(
                  'auto.components.skills.SkillBundleInstallOutcome.01c5a12e07',
                  'Bundle installation needs attention.'
                )
              : translate(
                  'auto.components.skills.SkillBundleInstallOutcome.01c5a12e08',
                  'Skills installed and verified.'
                )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.skills.SkillBundleInstallOutcome.01c5a12e09',
              '{{value0}} selected skills checked.',
              { value0: result.skills.length }
            )}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {RESULT_GROUPS.map((status) => {
          const skills = result.skills.filter((skill) => skill.status === status)
          return skills.length ? (
            <section key={status} className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                {resultGroupLabel(status)} · {skills.length}
              </p>
              {skills.map((skill) => (
                <p key={skill.skillId} className="text-xs">
                  {skill.name}
                  {skill.errorCategory ? ` · ${skill.errorCategory}` : ''}
                </p>
              ))}
            </section>
          ) : null
        })}
      </div>
    </div>
  )
}
