import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { ColorPicker } from '../ui/color-picker'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type RepositoryIconColorSectionProps = {
  badgeColor: string | null | undefined
  onBadgeColorChange: (color: string) => void
  onBadgeColorReset?: () => void
  badgeColorResetLabel?: string
}

export function RepositoryIconColorSection({
  badgeColor,
  onBadgeColorChange,
  onBadgeColorReset,
  badgeColorResetLabel
}: RepositoryIconColorSectionProps): React.JSX.Element {
  const normalizedBadgeColor = normalizeRepoBadgeColor(badgeColor)
  const selectedBadgeColor = normalizedBadgeColor ?? DEFAULT_REPO_BADGE_COLOR
  const isPresetBadgeColor = REPO_COLORS.some((color) => color === selectedBadgeColor)

  return (
    <div className="space-y-2">
      <Label className="text-sm font-semibold">
        {translate('auto.components.settings.RepositoryIconPicker.642dc29c6d', 'Color')}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        {REPO_COLORS.map((color) => (
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
        {normalizedBadgeColor && onBadgeColorReset && badgeColorResetLabel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2"
            onClick={onBadgeColorReset}
          >
            {badgeColorResetLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
