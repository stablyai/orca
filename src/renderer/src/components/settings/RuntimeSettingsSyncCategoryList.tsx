import { Check } from 'lucide-react'
import type { PortableSettingsCategory } from '../../../../shared/portable-settings'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Checkbox } from '../ui/checkbox'
import { Label } from '../ui/label'
import { getRuntimeSettingsSyncCategoryCopy } from './runtime-settings-sync-category-copy'

export type RuntimeSettingsSyncCategoryPreview = {
  category: PortableSettingsCategory
  differences: string[]
}

export function RuntimeSettingsSyncCategoryList({
  previews,
  selected,
  applying,
  onSelectedChange
}: {
  previews: RuntimeSettingsSyncCategoryPreview[]
  selected: ReadonlySet<PortableSettingsCategory>
  applying: boolean
  onSelectedChange: (category: PortableSettingsCategory, checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      {previews.map(({ category, differences }) => {
        const copy = getRuntimeSettingsSyncCategoryCopy(category)
        const matches = differences.length === 0
        return (
          <div
            key={category}
            className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5"
          >
            <Checkbox
              id={`portable-settings-${category}`}
              className="mt-0.5"
              checked={selected.has(category)}
              disabled={applying}
              onCheckedChange={(checked) => onSelectedChange(category, checked === true)}
            />
            <Label
              htmlFor={`portable-settings-${category}`}
              className="min-w-0 flex-1 cursor-pointer space-y-1"
            >
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{copy.title}</span>
                {matches ? (
                  <Badge variant="secondary" className="gap-1 text-[11px]">
                    <Check className="size-3" />
                    {translate(
                      'auto.components.settings.RuntimeSettingsSyncDialog.matches',
                      'Matches'
                    )}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[11px]">
                    {differences.length === 1
                      ? translate(
                          'auto.components.settings.RuntimeSettingsSyncDialog.change',
                          '1 change'
                        )
                      : translate(
                          'auto.components.settings.RuntimeSettingsSyncDialog.changes',
                          '{{value0}} changes',
                          { value0: differences.length }
                        )}
                  </Badge>
                )}
              </span>
              <span className="block text-xs font-normal text-muted-foreground">
                {copy.description}
              </span>
            </Label>
          </div>
        )
      })}
    </div>
  )
}
