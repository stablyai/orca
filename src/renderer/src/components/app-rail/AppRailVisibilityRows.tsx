import React from 'react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'

/** "Show on hover" / "Always show" under the rail's page checklist. */
export function AppRailVisibilityRows(): React.JSX.Element {
  const t = useTranslate()
  const visibility = useAppStore((s) =>
    s.settings?.appRailVisibility === 'always' ? 'always' : 'hover'
  )
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup
        value={visibility}
        onValueChange={(value) =>
          void useAppStore
            .getState()
            .updateSettings({ appRailVisibility: value === 'always' ? 'always' : 'hover' })
        }
      >
        <DropdownMenuRadioItem value="hover" indicator="check">
          {t('appRail.visibility.hover', 'Show on hover')}
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="always" indicator="check">
          {t('appRail.visibility.always', 'Always show')}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </>
  )
}
