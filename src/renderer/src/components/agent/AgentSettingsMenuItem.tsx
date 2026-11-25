import type { JSX } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

/** The new-tab menu's footer. Form pickers use the same row. */
export function AgentSettingsMenuItem({
  onSelect,
  variant = 'launch'
}: {
  onSelect: () => void
  /** `create` where it follows create rows rather than agent rows. */
  variant?: 'launch' | 'create'
}): JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem onSelect={onSelect} variant={variant}>
      <SettingsIcon className="size-4" />
      {t('auto.components.tab.bar.QuickLaunchButton.348a04c1ad', 'Agent settings…')}
    </DropdownMenuItem>
  )
}
