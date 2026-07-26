import type { SkillFreshnessGroupModel, SkillLocationChip } from './skill-freshness-grouping'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { skippedReason } from './skill-freshness-skipped-reason'

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
