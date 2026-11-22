import { useId } from 'react'
import type { BundledSkillLocation } from '../../../../../shared/skills/bundled/bundled-skill-locations'
import type { BundledSkillOutcome } from '../../../../../shared/skills/bundled/bundled-skill-plan'
import {
  bundledSkillOutcomeText,
  type BundledSkillPlanSkillSummary
} from '../../../../../shared/skills/bundled/bundled-skill-summary'
import { useTranslate } from '@/i18n/use-translate'
import { Checkbox } from '@/components/ui/checkbox'
import {
  locationPlaceLabel,
  locationStateText,
  skillOutcomeText,
  skillPlanHeadline
} from './skill-plan-op-copy'

export type SkillRowPhase = 'plan' | 'pending' | 'result'

export type SkillReplaceToggle = {
  isReplaced: (path: string) => boolean
  onReplaceChange: (path: string, replace: boolean) => void
}

function ChoiceLine({
  location,
  reason,
  replace
}: {
  location: BundledSkillLocation
  reason: string | null
  replace?: SkillReplaceToggle
}): React.JSX.Element | null {
  const t = useTranslate()
  const backupDescriptionId = useId()
  const movesFolder = location.observedKind === 'folder'
  if (!reason && !(replace && location.replaceable)) {
    return null
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {reason ? (
        <span className="min-w-0 [overflow-wrap:anywhere]" title={location.path}>
          {reason}
        </span>
      ) : null}
      {replace && location.replaceable ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <label className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              aria-describedby={movesFolder ? backupDescriptionId : undefined}
              checked={replace.isReplaced(location.path)}
              onCheckedChange={(checked) =>
                replace.onReplaceChange(location.path, checked === true)
              }
            />
            {t(
              'auto.components.skills.SkillUpdateRow.replaceWithOrca',
              "Replace with Orca's copy (keeps a backup)"
            )}
          </label>
          {movesFolder ? (
            <span id={backupDescriptionId} className="pl-5.5 text-xs text-muted-foreground">
              {t(
                'auto.components.skills.SkillUpdateRow.replaceMovesFolder',
                'Moves the whole folder and any extra files to a backup.'
              )}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function LocationTable({
  locations
}: {
  locations: readonly BundledSkillLocation[]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2">
      {locations.map((location) => (
        <div key={location.path} className="min-w-0 text-xs text-muted-foreground">
          <span>{locationPlaceLabel(location, t)}</span>
          {' · '}
          <span className="font-mono text-2xs [overflow-wrap:anywhere]" title={location.path}>
            {location.displayPath}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Show planned changes, locations left for the user and optional full folder details. */
export function SkillUpdateRow({
  skill,
  phase,
  outcome,
  replace,
  showLocations
}: {
  skill: BundledSkillPlanSkillSummary
  phase: SkillRowPhase
  outcome?: BundledSkillOutcome
  replace?: SkillReplaceToggle
  showLocations: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const replacement = skill.locations.find((location) => location.state === 'replace')
  const headline =
    phase === 'pending'
      ? t('auto.components.skills.SkillFreshnessUpdateDialog.updating', 'Updating…')
      : phase === 'result' && outcome
        ? // Why: a skill the run only reports on shows its left-alone lines, not "No change".
          bundledSkillOutcomeText(outcome) === 'No change' &&
          outcome.ops.some((op) => op.kind === 'leave')
          ? null
          : skillOutcomeText(outcome, t)
        : replacement
          ? locationStateText(replacement)
          : skillPlanHeadline(skill.state, t)
  const choices = skill.locations.filter(
    (location) => location.state === 'leave' || (phase !== 'result' && location.state === 'replace')
  )
  const seenReasons = new Set<string>()
  return (
    <div
      data-skill-row={skill.name}
      data-state-label={phase === 'plan' ? skill.state : phase}
      className="grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-x-3 border-b border-border/60 py-2.5 text-[13px] last:border-b-0"
    >
      <span className="truncate font-medium text-foreground" title={skill.name}>
        {skill.name}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5 text-foreground">
        {headline ? <span>{headline}</span> : null}
        {choices.map((location) => {
          const reason = location.state === 'leave' ? locationStateText(location) : null
          const uniqueReason = reason && !seenReasons.has(reason) ? reason : null
          if (reason) {
            seenReasons.add(reason)
          }
          return (
            <ChoiceLine
              key={location.path}
              location={location}
              reason={uniqueReason}
              {...(replace ? { replace } : {})}
            />
          )
        })}
        {showLocations ? <LocationTable locations={skill.locations} /> : null}
      </div>
    </div>
  )
}
