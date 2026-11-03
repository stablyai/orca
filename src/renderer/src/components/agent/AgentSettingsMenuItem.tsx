import type { JSX } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

/** The new-tab menu's footer. Form pickers use the same row. */
export function AgentSettingsMenuItem({ onSelect }: { onSelect: () => void }): JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect} variant="launch">
      <SettingsIcon className="size-4" />
      {translate('auto.components.tab.bar.QuickLaunchButton.348a04c1ad', 'Agent settings…')}
    </DropdownMenuItem>
  )
}
