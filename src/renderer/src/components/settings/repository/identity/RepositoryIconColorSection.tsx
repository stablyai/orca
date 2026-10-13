import {
  DEFAULT_REPO_BADGE_COLOR,
  REPO_COLORS,
  normalizeRepoBadgeColor
} from '../../../../../../shared/repository/appearance/repo-badge-color'
import { Label } from '../../../ui/label'
import { ColorPicker } from '../../../ui/color-picker'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

type RepositoryIconColorSectionProps = {
  badgeColor: string | null | undefined
  onBadgeColorChange: (color: string) => void
  sidebarHighlight: boolean
  onSidebarHighlightChange: (enabled: boolean) => void
}

export function RepositoryIconColorSection({
  badgeColor,
  onBadgeColorChange,
  sidebarHighlight,
  onSidebarHighlightChange
}: RepositoryIconColorSectionProps): React.JSX.Element {
  const t = useTranslate()
  const selectedBadgeColor = normalizeRepoBadgeColor(badgeColor) ?? DEFAULT_REPO_BADGE_COLOR
  const isPresetBadgeColor = REPO_COLORS.some((color) => color === selectedBadgeColor)

  return (
    <div className="space-y-2">
      <Label className="text-sm font-semibold">
        {t('auto.components.settings.RepositoryIconPicker.642dc29c6d', 'Color')}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        {REPO_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onBadgeColorChange(color)}
            aria-label={t(
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
      </div>
      <SettingsSwitchRow
        label={t(
          'auto.components.settings.RepositoryIconPicker.7a3c1e9f52',
          'Highlight project in sidebar'
        )}
        description={t(
          'auto.components.settings.RepositoryIconPicker.4b8d2f6a13',
          'Tint the project and all its workspaces with this color.'
        )}
        checked={sidebarHighlight}
        onChange={() => onSidebarHighlightChange(!sidebarHighlight)}
      />
    </div>
  )
}
