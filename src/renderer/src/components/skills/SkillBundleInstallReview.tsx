import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import type { SkillBundleInstallPreview } from '../../../../shared/skill-bundle-install-contract'
import { SkillPackageChecklist } from './SkillPackageChecklist'
import { checklistItemsFromVersion } from './skill-package-checklist-items'
import { SkillInstallRiskNotice } from './SkillInstallRiskNotice'
import type { SkillInstallRiskSummary } from './skill-package-install-risk'
import { translate } from '@/i18n/i18n'

type BundleVersion = SkillCloudVersion & {
  manifest: Extract<SkillCloudVersion['manifest'], { skills: unknown }>
}

const CONFLICT_STATES = new Set(['modified', 'unowned', 'external-link', 'name-collision'])

// Why: the row already names the skill, so the note only has to say what
// installing it would do to the copy already on the machine.
function destinationNotes(
  preview: SkillBundleInstallPreview | null
): ReadonlyMap<string, string> | undefined {
  if (!preview) {
    return undefined
  }
  return new Map(
    preview.skills.map((skill) => [
      skill.id,
      CONFLICT_STATES.has(skill.currentState)
        ? translate('auto.components.skills.install.rowNeedsDecision', 'Needs a decision')
        : skill.currentState === 'unchanged'
          ? translate('auto.components.skills.install.rowInstalled', 'Already installed')
          : skill.currentState === 'clean-update'
            ? translate('auto.components.skills.install.rowUpdate', 'Update')
            : translate('auto.components.skills.install.rowNew', 'New')
    ])
  )
}

export function SkillBundleInstallReview(props: {
  version: BundleVersion
  selectedSkillIds: ReadonlySet<string>
  destinationPreview: SkillBundleInstallPreview | null
  replaceSkillIds: ReadonlySet<string>
  riskSummary: SkillInstallRiskSummary
  busy: boolean
  onToggleSkill(skillId: string, selected: boolean): void
  onToggleAll(selected: boolean): void
  onToggleReplace(skillId: string, replace: boolean): void
  children: ReactNode
}): React.JSX.Element {
  const { manifest } = props.version
  const conflicts =
    props.destinationPreview?.skills.filter((skill) => CONFLICT_STATES.has(skill.currentState)) ??
    []
  const allSelected = props.selectedSkillIds.size === manifest.skills.length

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-border/70 bg-card/40 p-3.5">
        {manifest.skills.length > 1 ? (
          <div className="flex items-center justify-between gap-3 pb-1">
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.skills.install.chooseSkills',
                'Choose what to install from this link.'
              )}
            </p>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
              <Checkbox
                checked={allSelected ? true : props.selectedSkillIds.size ? 'indeterminate' : false}
                disabled={props.busy}
                onCheckedChange={(checked) => props.onToggleAll(checked === true)}
              />
              {translate(
                'auto.components.skills.SkillBundleInstallReview.01c5a11e0d',
                'Select all'
              )}
            </label>
          </div>
        ) : null}
        <SkillPackageChecklist
          items={checklistItemsFromVersion(props.version)}
          selectedIds={props.selectedSkillIds}
          notes={destinationNotes(props.destinationPreview)}
          busy={props.busy}
          onSelectedChange={props.onToggleSkill}
        />
        {props.version.releaseNotes.trim() ? (
          <p className="break-words whitespace-pre-wrap rounded-lg border border-border/40 bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
            <span className="font-semibold text-foreground">
              {translate(
                'auto.components.skills.SkillBundleInstallReview.01c5a11e09',
                'Release notes:'
              )}
            </span>{' '}
            {props.version.releaseNotes}
          </p>
        ) : null}
        <SkillInstallRiskNotice summary={props.riskSummary} />
      </div>

      <div className="space-y-3 rounded-xl border border-border/70 bg-card/40 p-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {translate(
            'auto.components.skills.SkillInstallReviewContent.targetHeader',
            'Installation Target'
          )}
        </div>
        {props.children}
      </div>

      {conflicts.length ? (
        <section
          className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5"
          role="alert"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4 shrink-0" />{' '}
            {translate(
              'auto.components.skills.SkillBundleInstallReview.01c5a11e11',
              'Local copies need a decision'
            )}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.skills.SkillBundleInstallReview.01c5a11e12',
              'Orca will keep these local copies by default. Select only the copies you want to discard and replace.'
            )}
          </p>
          <div className="space-y-2">
            {conflicts.map((conflict) => (
              <label key={conflict.id} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={props.replaceSkillIds.has(conflict.id)}
                  disabled={props.busy}
                  onCheckedChange={(checked) =>
                    props.onToggleReplace(conflict.id, checked === true)
                  }
                />
                {translate(
                  'auto.components.skills.SkillBundleInstallReview.01c5a11e13',
                  'Replace {{value0}} ({{value1}})',
                  { value0: conflict.name, value1: conflict.currentState }
                )}
              </label>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
