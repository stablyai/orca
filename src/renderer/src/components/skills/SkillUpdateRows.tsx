import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { BundledSkillOutcome, BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import {
  bundledSkillOutcomeText,
  bundledSkillPlanState
} from '../../../../shared/bundled-skill-summary'
import type {
  BundledSkillPlanSkillSummary,
  BundledSkillPlanState
} from '../../../../shared/bundled-skill-summary'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkillUpdateRow, type SkillReplaceToggle, type SkillRowPhase } from './SkillUpdateRow'

// Why: what Update changes reads first, then what it leaves for the user.
const ROW_ORDER: readonly BundledSkillPlanState[] = [
  'repair',
  'update',
  'install',
  'attention',
  'current'
]

/** A finished run lists what it changed and what it left; untouched skills stay off. */
function resultShowsRow(outcome: BundledSkillOutcome | undefined): boolean {
  return Boolean(
    outcome &&
    (bundledSkillOutcomeText(outcome) !== 'No change' ||
      outcome.ops.some((op) => op.kind === 'leave'))
  )
}

function UpToDateLine({
  skills
}: {
  skills: readonly BundledSkillPlanSkillSummary[]
}): React.JSX.Element | null {
  const upToDate = skills.filter((skill) => skill.upToDate)
  if (upToDate.length === 0) {
    return null
  }
  return (
    <p className="text-xs text-muted-foreground">
      {upToDate.length === 1
        ? translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.upToDateOne',
            '{{value0}} is up to date.',
            { value0: upToDate[0].name }
          )
        : translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.upToDateMany',
            '{{value0}} skills are up to date.',
            { value0: upToDate.length }
          )}
    </p>
  )
}

/** The skill rows plus, while reviewing, the up-to-date line and the locations toggle. */
export function SkillUpdateRows({
  skills,
  unforcedPlan,
  hasWork,
  phase,
  outcomes,
  replace,
  showLocations,
  onToggleLocations
}: {
  skills: readonly BundledSkillPlanSkillSummary[]
  unforcedPlan: BundledSkillPlan | null
  hasWork: boolean
  phase: SkillRowPhase
  outcomes: ReadonlyMap<string, BundledSkillOutcome>
  replace: SkillReplaceToggle
  showLocations: boolean
  onToggleLocations: () => void
}): React.JSX.Element {
  const unforcedStates = new Map(
    unforcedPlan?.skills.map((entry) => [entry.name, bundledSkillPlanState(entry)])
  )
  const plannedSkills = [...skills].sort(
    (left, right) =>
      ROW_ORDER.indexOf(unforcedStates.get(left.name) ?? left.state) -
      ROW_ORDER.indexOf(unforcedStates.get(right.name) ?? right.state)
  )
  const [previewOrder, setPreviewOrder] = useState<string[]>([])
  if (
    phase === 'plan' &&
    (previewOrder.length !== plannedSkills.length ||
      plannedSkills.some((skill, index) => skill.name !== previewOrder[index]))
  ) {
    setPreviewOrder(plannedSkills.map((skill) => skill.name))
  }
  // Why: completion refreshes the plan, but result rows must keep their preview positions.
  const previewRanks = new Map(previewOrder.map((name, index) => [name, index]))
  const orderedSkills =
    phase === 'plan'
      ? plannedSkills
      : [...skills].sort(
          (left, right) =>
            (previewRanks.get(left.name) ?? previewOrder.length) -
            (previewRanks.get(right.name) ?? previewOrder.length)
        )
  return (
    <div className="min-w-0 border-t border-border/60">
      <TooltipProvider>
        {orderedSkills
          .filter((skill) =>
            phase === 'result'
              ? resultShowsRow(outcomes.get(skill.name))
              : showLocations || !skill.upToDate
          )
          .map((skill) => (
            <SkillUpdateRow
              key={skill.name}
              skill={skill}
              phase={phase}
              outcome={outcomes.get(skill.name)}
              replace={replace}
              showLocations={showLocations && phase !== 'result'}
            />
          ))}
      </TooltipProvider>
      {phase === 'plan' ? (
        <div className="flex flex-col items-start gap-1 pt-2.5">
          {!showLocations && hasWork ? <UpToDateLine skills={skills} /> : null}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="-ml-2"
            onClick={onToggleLocations}
          >
            {showLocations
              ? translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.hideFolders',
                  'Hide folders'
                )
              : translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.showFolders',
                  'Show folders'
                )}
            {showLocations ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
