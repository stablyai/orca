import type React from 'react'
import { Monitor } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

/** "Open remote desktop" in a cloud workspace's menu, with the separator that groups it first. */
export function RemoteDesktopMenuEntry({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DropdownMenuItem onSelect={onSelect}>
        <Monitor className="size-3.5" />
        {t('components.cloudRemoteDesktop.openMenuItem', 'Open remote desktop')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  )
}
