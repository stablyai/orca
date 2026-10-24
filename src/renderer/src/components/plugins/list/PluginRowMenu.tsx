import { Info, MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'

export async function copyPluginId(pluginKey: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(pluginKey)
    toast.success(
      translate('auto.components.settings.PluginManagerRows.copied', 'Plugin ID copied')
    )
  } catch {
    toast.error(
      translate(
        'auto.components.settings.PluginManagerRows.copyFailed',
        "Couldn't copy the plugin ID."
      )
    )
  }
}

export async function copyContentHash(hash: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(hash)
    toast.success(
      translate('auto.components.settings.PluginDetailInfo.hashCopied', 'Content hash copied')
    )
  } catch {
    toast.error(
      translate(
        'auto.components.settings.PluginDetailInfo.hashCopyFailed',
        "Couldn't copy the hash."
      )
    )
  }
}

export function MoreButton({
  name,
  children
}: {
  name: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'auto.components.settings.PluginSettingsRow.moreActions',
            'More actions for {{value0}}',
            { value0: name }
          )}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DetailsItem({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Info />
      {translate('auto.components.settings.PluginManagerRows.details', 'Details')}
    </DropdownMenuItem>
  )
}
