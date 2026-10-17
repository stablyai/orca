import { EyeOff } from 'lucide-react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isIncognitoRepo } from '../../../../shared/incognito-projects'
import { FilterToggleRow } from './FilterToggleRow'

/** Not a filter: "Clear filters" and jump-to-workspace must never reveal incognito projects. */
export function SidebarIncognitoToggle({
  onBeforeToggle
}: {
  /** Closes the menu so Touch ID and the passcode dialog never sit under it. */
  onBeforeToggle: () => void
}): React.JSX.Element | null {
  const hasIncognitoProjects = useAppStore((s) => s.repos.some(isIncognitoRepo))
  const unlocked = useAppStore((s) => s.incognitoProjectsUnlocked)
  const requestUnlock = useAppStore((s) => s.requestIncognitoProjectsUnlock)
  const lock = useAppStore((s) => s.lockIncognitoProjects)
  if (!hasIncognitoProjects) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <FilterToggleRow
        icon={<EyeOff className="size-3.5" />}
        label={translate('incognitoProjects.showIncognito', 'Show incognito projects')}
        checked={unlocked}
        onChange={(show) => {
          onBeforeToggle()
          void (show ? requestUnlock() : lock())
        }}
      />
    </>
  )
}
