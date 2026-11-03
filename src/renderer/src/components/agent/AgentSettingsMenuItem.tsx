import type { JSX } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

/** The new-tab menu's footer. Form pickers use the same row. */
export function AgentSettingsMenuItem({ onSelect }: { onSelect: () => void }): JSX.Element {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className="gap-2 rounded-[7px] px-2 py-1 text-[12px] leading-4 font-medium text-muted-foreground"
    >
      <SettingsIcon className="size-4" />
      {translate('auto.components.tab.bar.QuickLaunchButton.348a04c1ad', 'Agent settings…')}
    </DropdownMenuItem>
  )
}
