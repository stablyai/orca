import type React from 'react'
import { Info } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import type {
  SourceControlActionRecipeOverrideField,
  SourceControlActionRecipeOverrideSummary
} from '@/lib/source-control-launch-agent-selection'
import { translate } from '@/i18n/i18n'

type SourceControlActionRepoOverrideNoteProps = {
  summary: SourceControlActionRecipeOverrideSummary
  onReviewRepo: (repoId: string) => void
}

const MAX_VISIBLE_REPOS = 5

function getRecipeOverrideFieldLabel(field: SourceControlActionRecipeOverrideField): string {
  switch (field) {
    case 'agent':
      return translate(
        'auto.components.settings.SourceControlActionRepoOverrideNote.agent',
        'Agent'
      )
    case 'agentArgs':
      return translate(
        'auto.components.settings.SourceControlActionRepoOverrideNote.agentArgs',
        'CLI arguments'
      )
    case 'commandTemplate':
      return translate(
        'auto.components.settings.SourceControlActionRepoOverrideNote.commandTemplate',
        'Command template'
      )
  }
}

function getRecipeOverrideFieldSummary(fields: SourceControlActionRecipeOverrideField[]): string {
  if (fields.length === 0) {
    return translate(
      'auto.components.settings.SourceControlActionRepoOverrideNote.recipe',
      'Recipe'
    )
  }
  return fields.map(getRecipeOverrideFieldLabel).join(', ')
}

export function SourceControlActionRepoOverrideNote({
  summary,
  onReviewRepo
}: SourceControlActionRepoOverrideNoteProps): React.JSX.Element | null {
  if (summary.count === 0) {
    return null
  }
  const firstOverride = summary.overrides[0]
  if (!firstOverride) {
    return null
  }
  const visibleOverrides = summary.overrides.slice(0, MAX_VISIBLE_REPOS)
  const hiddenOverrideCount = Math.max(0, summary.overrides.length - visibleOverrides.length)
  const noteText =
    summary.count === 1
      ? translate(
          'auto.components.settings.SourceControlActionRepoOverrideNote.singular',
          "Global saves won't change 1 repository with its own recipe."
        )
      : translate(
          'auto.components.settings.SourceControlActionRepoOverrideNote.plural',
          "Global saves won't change {{count}} repositories with their own recipes.",
          { count: summary.count }
        )
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 items-start gap-1.5">
            <Info className="mt-px size-3 shrink-0" />
            <span>{noteText}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-[18rem]">
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium">
              {translate(
                'auto.components.settings.SourceControlActionRepoOverrideNote.tooltipTitle',
                'Repository overrides'
              )}
            </p>
            <ul className="space-y-1">
              {visibleOverrides.map((override) => (
                <li key={override.repoId} className="space-y-0.5">
                  <div>{override.repoName}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {getRecipeOverrideFieldSummary(override.fields)}
                  </div>
                </li>
              ))}
            </ul>
            {hiddenOverrideCount > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.settings.SourceControlActionRepoOverrideNote.more',
                  '+{{count}} more',
                  { count: hiddenOverrideCount }
                )}
              </p>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto px-0 py-0 text-[11px]"
        onClick={() => onReviewRepo(firstOverride.repoId)}
      >
        {summary.count === 1
          ? translate(
              'auto.components.settings.SourceControlActionRepoOverrideNote.review',
              'Review'
            )
          : translate(
              'auto.components.settings.SourceControlActionRepoOverrideNote.reviewFirst',
              'Review first'
            )}
      </Button>
    </div>
  )
}
