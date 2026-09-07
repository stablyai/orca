import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { ColorPicker } from '../ui/color-picker'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type RepositoryIconColorSectionProps = {
  badgeColor: string | null | undefined
  onBadgeColorChange: (color: string) => void
}

export function RepositoryIconColorSection({
  badgeColor,
  onBadgeColorChange
}: RepositoryIconColorSectionProps): React.JSX.Element {
  const selectedBadgeColor = normalizeRepoBadgeColor(badgeColor) ?? DEFAULT_REPO_BADGE_COLOR
  const isPresetBadgeColor = REPO_COLORS.some((color) => color === selectedBadgeColor)

  return (
    <div className="space-y-2">
      <Label className="text-sm font-semibold">Project accent</Label>
      <p className="text-xs text-muted-foreground">
        Shown beside project names. Neutral turns accents off.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label="Neutral (accents off)"
          aria-pressed={selectedBadgeColor === DEFAULT_REPO_BADGE_COLOR}
          onClick={() => onBadgeColorChange(DEFAULT_REPO_BADGE_COLOR)}
        >
          Neutral
        </Button>
        {REPO_COLORS.filter((color) => color !== DEFAULT_REPO_BADGE_COLOR).map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onBadgeColorChange(color)}
            aria-label={translate(
              'auto.components.settings.RepositoryIconPicker.2b7d27b93c',
              'Use {{value0}} repo color',
              { value0: color }
            )}
            aria-pressed={selectedBadgeColor === color}
            className={cn(
              'size-7 rounded-[4px] outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selectedBadgeColor === color
                ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                : 'hover:ring-1 hover:ring-muted-foreground hover:ring-offset-2 hover:ring-offset-background'
            )}
            style={{ backgroundColor: color }}
          />
        ))}
        <ColorPicker
          value={selectedBadgeColor}
          onChange={onBadgeColorChange}
          label={
            isPresetBadgeColor
              ? translate(
                  'auto.components.settings.RepositoryIconPicker.0e5f0693c1',
                  'Choose custom repo color'
                )
              : translate(
                  'auto.components.settings.RepositoryIconPicker.913c55833d',
                  'Custom repo color {{value0}}',
                  { value0: selectedBadgeColor }
                )
          }
          selected={!isPresetBadgeColor}
          triggerLabel="Custom"
          showHexInTrigger={!isPresetBadgeColor}
          className="h-7 px-2"
        />
      </div>
    </div>
  )
}
