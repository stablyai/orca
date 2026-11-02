import { AlertTriangle, CheckCircle2, ChevronDown, Circle, Info, XCircle } from 'lucide-react'
import type { SkillFreshnessGroupModel } from './skill-freshness-grouping'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { chipLabel, chipTooltip } from './skill-location-chip-copy'
import { skippedReason } from './skill-freshness-skipped-reason'

export type SkillRowState = 'available' | 'blocked' | 'pending' | 'done' | 'failed'

/**
 * Leading status glyph. Absent for `available` on purpose: an empty reserved box
 * would just indent the name past a gap with nothing in it.
 */
function StateIcon({ state }: { state: SkillRowState }): React.JSX.Element | null {
  switch (state) {
    case 'done':
      return <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
    case 'failed':
      return <XCircle className="size-4 shrink-0 text-destructive" />
    case 'pending':
      return <Circle className="size-4 shrink-0 text-muted-foreground" />
    case 'blocked':
      return <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
    case 'available':
      return null
  }
}

function notFromOrcaTooltip(lockSource: string | null): string {
  return lockSource
    ? translate(
        'auto.components.skills.SkillUpdateRow.notFromOrcaSourceTip',
        'Installed from {{value0}}. Selecting it replaces it with Orca’s version.',
        { value0: lockSource }
      )
    : translate(
        'auto.components.skills.SkillUpdateRow.notFromOrcaNoRecordTip',
        'No Orca install record for this copy. Selecting it replaces it with Orca’s version.'
      )
}

/** Sits immediately right of the name, so the label reads as part of it. */
function StateBadge({
  state,
  group
}: {
  state: SkillRowState
  group: SkillFreshnessGroupModel
}): React.JSX.Element | null {
  if (state === 'blocked') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-amber-600/50 text-amber-700 dark:border-amber-400/40 dark:text-amber-400"
      >
        {translate('auto.components.skills.SkillFreshnessRow.statusCantUpdate', 'Skipped')}
      </Badge>
    )
  }
  if (state === 'available' && !group.orcaOwned) {
    // Why: quiet on purpose; the copy is offered, not recommended.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-sm text-xs font-normal text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {translate('auto.components.skills.SkillUpdateRow.notFromOrca', 'Not from Orca')}
            <Info className="size-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-pretty">
          {notFromOrcaTooltip(group.lockSource)}
        </TooltipContent>
      </Tooltip>
    )
  }
  if (state === 'available') {
    return (
      <Badge variant="secondary" className="shrink-0">
        {translate(
          'auto.components.skills.SkillFreshnessRow.statusUpdateAvailable',
          'Update available'
        )}
      </Badge>
    )
  }
  // Why: once a run owns the row the leading glyph carries the state. A stale
  // "Update available" beside a green check would contradict it.
  return null
}

/**
 * One skill in the update dialog, used unchanged in every state.
 *
 * The header keeps identical geometry from "update available" through running to
 * the result — the row keeps its place and its right edge — so pressing Update
 * doesn't replace the dialog's layout with a different one. Locations live
 * behind a per-skill disclosure instead of being dumped inline, because a skill
 * with several plugin-cache copies otherwise buries the actions.
 */
export function SkillUpdateRow({
  group,
  state,
  selection
}: {
  group: SkillFreshnessGroupModel
  state: SkillRowState
  /** Present only while the user is choosing what to update. */
  selection?: { checked: boolean; onCheckedChange: (checked: boolean) => void }
}): React.JSX.Element {
  const locationCount = group.locations.length
  return (
    <Collapsible
      data-skill-row={group.name}
      data-state-label={state}
      // Negative margin lets the hover surface breathe past the text while the
      // name itself still lines up with the dialog's other content.
      className="-mx-1.5 border-t border-border/60 py-0.5 first:border-t-0"
    >
      <div
        className={cn(
          'flex min-w-0 items-center transition-opacity',
          state === 'pending' && 'opacity-60'
        )}
      >
        {/* Why: outside the trigger, so ticking a row never toggles its disclosure. */}
        {selection ? (
          <Checkbox
            className="ml-1.5"
            checked={selection.checked}
            onCheckedChange={(checked) => selection.onCheckedChange(checked === true)}
            aria-label={translate(
              'auto.components.skills.SkillUpdateRow.includeSkill',
              'Include {{value0}}',
              { value0: group.name }
            )}
          />
        ) : null}
        <CollapsibleTrigger variant="row" className="min-w-0">
          {/* Margins, not trigger padding, inset the content inside the hover surface. */}
          <span className="ml-1.5 flex min-w-0 flex-1 items-center gap-2">
            <StateIcon state={state} />
            <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
              {group.name}
            </span>
            <StateBadge state={state} group={group} />
          </span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
            {locationCount === 1
              ? translate('auto.components.skills.SkillUpdateRow.oneLocation', '1 location')
              : translate(
                  'auto.components.skills.SkillUpdateRow.manyLocations',
                  '{{value0}} locations',
                  { value0: locationCount }
                )}
          </span>
          <ChevronDown className="mr-1.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
      </div>

      {state === 'failed' ? (
        <p className="px-1.5 pb-1.5 text-xs leading-5 text-muted-foreground">
          {translate(
            'auto.components.skills.SkillUpdateResultRows.stillOutdated',
            'Still out of date after the update ran.'
          )}
        </p>
      ) : null}

      {/* Why: outside the disclosure, alongside the failure line. The reason is
          the whole point of a skipped row, so it must not depend on a click —
          nor on a mount-time `defaultOpen` that a re-scan can't re-fire. */}
      {state === 'blocked' ? (
        <p className="px-1.5 pb-1.5 text-xs leading-5 text-muted-foreground">
          {skippedReason(group.locations)}
        </p>
      ) : null}

      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="flex flex-col gap-2 px-1.5 pb-2 pt-0.5">
          {group.locations.map((location) => (
            <div key={location.id} className="flex min-w-0 items-center gap-2">
              {/* Why: plugin-cache paths nest arbitrarily deep. Without an explicit
                  shrink basis the unbreakable string sets the dialog's width and
                  pushes the footer actions off-screen. */}
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                title={location.path}
              >
                {location.path}
              </span>
              {location.chip ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="shrink-0 cursor-help border-dashed">
                      {chipLabel(location.chip)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-pretty">
                    {chipTooltip(location.chip)}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
