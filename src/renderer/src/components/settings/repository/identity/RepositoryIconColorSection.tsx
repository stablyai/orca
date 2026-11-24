import { Pipette, Sparkles } from 'lucide-react'
import {
  DEFAULT_REPO_BADGE_COLOR,
  REPO_COLORS,
  normalizeRepoBadgeColor
} from '../../../../../../shared/repository/appearance/repo-badge-color'
import { Label } from '../../../ui/label'
import { ColorPicker } from '../../../ui/color-picker'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

const AUTO_SWATCH_STOPS = [...REPO_COLORS.slice(1), REPO_COLORS[1]].join(', ')

type RepositoryIconColorSectionProps = {
  badgeColor: string | null | undefined
  onBadgeColorChange: (color: string) => void
  /** Hover-card layout: an 8-column grid, no heading, no nested custom-color popover. */
  compact?: boolean
  /** The color Auto currently resolves to, so the Auto swatch previews it. */
  autoColor?: string
}

export function RepositoryIconColorSection({
  badgeColor,
  onBadgeColorChange,
  compact = false,
  autoColor
}: RepositoryIconColorSectionProps): React.JSX.Element {
  const t = useTranslate()
  const selectedBadgeColor = normalizeRepoBadgeColor(badgeColor) ?? DEFAULT_REPO_BADGE_COLOR
  const isPresetBadgeColor = REPO_COLORS.some((color) => color === selectedBadgeColor)
  const customLabel = isPresetBadgeColor
    ? t('auto.components.settings.RepositoryIconPicker.0e5f0693c1', 'Choose custom repo color')
    : t(
        'auto.components.settings.RepositoryIconPicker.913c55833d',
        'Custom repo color {{value0}}',
        {
          value0: selectedBadgeColor
        }
      )
  const autoLabel = t(
    'auto.components.settings.RepositoryIconPicker.autoColor',
    'Automatic color (kept distinct from other projects)'
  )

  return (
    <div className={cn(!compact && 'space-y-2')}>
      {!compact && (
        <Label className="text-sm font-semibold">
          {t('auto.components.settings.RepositoryIconPicker.642dc29c6d', 'Color')}
        </Label>
      )}
      <div
        className={cn(
          compact
            ? 'grid grid-cols-9 justify-items-center gap-1 px-0.5'
            : 'flex flex-wrap items-center gap-2'
        )}
      >
        {REPO_COLORS.map((color) => {
          // Why: neutral is the stored default, which the sidebar treats as "pick a distinct color".
          const isAuto = color === DEFAULT_REPO_BADGE_COLOR
          const label = isAuto
            ? autoLabel
            : t(
                'auto.components.settings.RepositoryIconPicker.2b7d27b93c',
                'Use {{value0}} repo color',
                { value0: color }
              )
          return (
            <button
              key={color}
              type="button"
              onClick={() => onBadgeColorChange(color)}
              aria-label={label}
              title={isAuto ? autoLabel : undefined}
              aria-pressed={selectedBadgeColor === color}
              className={cn(
                'inline-flex items-center justify-center outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50',
                compact ? 'size-6 rounded-md' : 'size-7 rounded-[4px]',
                isAuto &&
                  (compact
                    ? null
                    : 'border border-dashed border-muted-foreground/60 text-muted-foreground'),
                selectedBadgeColor === color
                  ? compact
                    ? 'ring-2 ring-foreground/80 ring-offset-1 ring-offset-transparent'
                    : 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                  : 'hover:ring-1 hover:ring-muted-foreground hover:ring-offset-2 hover:ring-offset-background'
              )}
              style={
                isAuto
                  ? compact
                    ? {
                        // Why: Auto reads as "any of these", centered on what it picks right now.
                        backgroundImage:
                          autoColor && autoColor !== DEFAULT_REPO_BADGE_COLOR
                            ? `radial-gradient(circle, ${autoColor} 30%, transparent 33%), conic-gradient(${AUTO_SWATCH_STOPS})`
                            : `conic-gradient(${AUTO_SWATCH_STOPS})`
                      }
                    : undefined
                  : { backgroundColor: color }
              }
            >
              {isAuto && !compact && <Sparkles className="size-3.5" />}
            </button>
          )
        })}
        {compact && (
          <ColorPicker
            value={selectedBadgeColor}
            onChange={onBadgeColorChange}
            selected={!isPresetBadgeColor}
            label={customLabel}
            trigger={
              // Grid-sized trigger for the swatch row: the custom color when chosen, else an eyedropper.
              <button
                type="button"
                aria-label={customLabel}
                aria-pressed={!isPresetBadgeColor}
                title={customLabel}
                className={cn(
                  'inline-flex size-6 items-center justify-center rounded-md outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  isPresetBadgeColor
                    ? 'border border-dashed border-muted-foreground/60 text-muted-foreground hover:border-foreground/60 hover:text-foreground'
                    : 'ring-2 ring-foreground/80 ring-offset-1 ring-offset-transparent'
                )}
                style={isPresetBadgeColor ? undefined : { backgroundColor: selectedBadgeColor }}
              >
                {isPresetBadgeColor ? <Pipette className="size-3" /> : null}
              </button>
            }
          />
        )}
        {!compact && (
          <ColorPicker
            value={selectedBadgeColor}
            onChange={onBadgeColorChange}
            label={
              isPresetBadgeColor
                ? t(
                    'auto.components.settings.RepositoryIconPicker.0e5f0693c1',
                    'Choose custom repo color'
                  )
                : t(
                    'auto.components.settings.RepositoryIconPicker.913c55833d',
                    'Custom repo color {{value0}}',
                    { value0: selectedBadgeColor }
                  )
            }
            selected={!isPresetBadgeColor}
            triggerLabel={t('auto.components.settings.RepositoryIconPicker.custom', 'Custom')}
            showHexInTrigger={!isPresetBadgeColor}
            className="h-7 px-2"
          />
        )}
      </div>
    </div>
  )
}
