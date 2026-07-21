import type {
  SkillFreshnessGroupModel,
  SkillLocationChip,
  SkillLocationRow
} from './skill-freshness-grouping'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

function chipLabel(chip: SkillLocationChip): string {
  switch (chip) {
    case 'current':
      return translate('auto.components.skills.SkillFreshnessRow.chipCurrent', 'Current')
    case 'unrecognized':
      return translate('auto.components.skills.SkillFreshnessRow.chipUnrecognized', 'Unrecognized')
    case 'inaccessible':
      return translate('auto.components.skills.SkillFreshnessRow.chipInaccessible', 'Inaccessible')
    case 'duplicate':
      return translate('auto.components.skills.SkillFreshnessRow.chipDuplicate', 'Duplicate')
    case 'external-link':
      return translate('auto.components.skills.SkillFreshnessRow.chipExternalLink', 'External link')
    case 'broken-link':
      return translate('auto.components.skills.SkillFreshnessRow.chipBrokenLink', 'Broken link')
    case 'read-only':
      return translate('auto.components.skills.SkillFreshnessRow.chipReadOnly', 'Read only')
    case 'in-a-repo':
      return translate('auto.components.skills.SkillFreshnessRow.chipInRepo', 'In a repo')
    case 'plugin-cache':
      return translate('auto.components.skills.SkillFreshnessRow.chipPluginCache', 'Plugin cache')
  }
}

// Why: chips describe only what a location *is*; the effect on the update
// command lives in the per-skill sentence, so the two never say it twice.
function chipTooltip(chip: SkillLocationChip): string {
  switch (chip) {
    case 'current':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipCurrent',
        'This copy matches the current official version.'
      )
    case 'unrecognized':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipUnrecognized',
        'This copy doesn’t match any official version — it may be modified, or a different skill with the same name.'
      )
    case 'inaccessible':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipInaccessible',
        'Orca couldn’t read this copy (a permissions or file error).'
      )
    case 'duplicate':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipDuplicate',
        'A separate copy of this skill, installed apart from the main one.'
      )
    case 'external-link':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipExternalLink',
        'A shortcut pointing outside Orca’s skill folders.'
      )
    case 'broken-link':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipBrokenLink',
        'A shortcut to something that no longer exists.'
      )
    case 'read-only':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipReadOnly',
        'This copy is in a read-only location.'
      )
    case 'in-a-repo':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipInRepo',
        'This copy lives inside a project, not your global skills.'
      )
    case 'plugin-cache':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipPluginCache',
        'This copy is managed by a plugin.'
      )
  }
}

// Why: a skill is skipped for one concrete reason; lead with the highest-priority
// blocking placement so the sentence explains the real cause (an edited copy is
// more useful to surface than a downstream symptom).
const SKIPPED_REASON_PRIORITY: SkillLocationChip[] = [
  'unrecognized',
  'read-only',
  'inaccessible',
  'in-a-repo',
  'plugin-cache',
  'external-link',
  'broken-link'
]

function skippedReason(locations: readonly SkillLocationRow[]): string {
  const present = new Set(locations.map((location) => location.chip))
  const chip = SKIPPED_REASON_PRIORITY.find((candidate) => present.has(candidate))
  switch (chip) {
    case 'unrecognized':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonUnrecognized',
        'The copy here doesn’t match the official version — it may be modified, or a different skill with the same name. Orca left it out of the update so it won’t overwrite it. Remove it if you want Orca to update this skill.'
      )
    case 'read-only':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonReadOnly',
        'This copy is in a read-only location, so Orca left it out of the update. Change its permissions to let Orca update it.'
      )
    case 'inaccessible':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonInaccessible',
        'Orca couldn’t read this copy, so it left the skill out of the update.'
      )
    case 'in-a-repo':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonInRepo',
        'This is a project skill, not a global one — Orca only updates your global skills, so it left this out of the update.'
      )
    case 'plugin-cache':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonPluginCache',
        'A plugin manages this skill, so Orca left it out of the update — update the plugin instead.'
      )
    case 'external-link':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonExternalLink',
        'This copy is a shortcut pointing outside Orca’s skill folders, so Orca left it out of the update.'
      )
    case 'broken-link':
      return translate(
        'auto.components.skills.SkillFreshnessRow.skippedReasonBrokenLink',
        'This copy is a shortcut to something that no longer exists, so Orca left it out — you can safely delete it.'
      )
    default:
      return translate(
        'auto.components.skills.SkillFreshnessRow.cantUpdateReason',
        'Orca left this skill out of the update command.'
      )
  }
}

export function SkillFreshnessGroup({
  group
}: {
  group: SkillFreshnessGroupModel
}): React.JSX.Element {
  const isBlocked = group.status === 'cannot-update'
  return (
    <div className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{group.name}</span>
        {isBlocked ? (
          <Badge
            variant="outline"
            className="border-amber-600/50 text-amber-700 dark:border-amber-400/40 dark:text-amber-400"
          >
            {translate('auto.components.skills.SkillFreshnessRow.statusCantUpdate', 'Skipped')}
          </Badge>
        ) : (
          <Badge variant="secondary">
            {translate(
              'auto.components.skills.SkillFreshnessRow.statusUpdateAvailable',
              'Update available'
            )}
          </Badge>
        )}
      </div>
      {isBlocked ? (
        <p className="text-xs leading-5 text-muted-foreground">{skippedReason(group.locations)}</p>
      ) : null}
      <div className="flex flex-col gap-2">
        {group.locations.map((location) => (
          <div
            key={location.id}
            className="flex min-w-0 flex-wrap items-center gap-2 border-l-2 border-border/60 pl-3"
          >
            <span
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={location.path}
            >
              {location.path}
            </span>
            {location.chip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="cursor-help border-dashed">
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
    </div>
  )
}
