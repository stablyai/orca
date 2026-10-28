import { RefreshCw } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import type { OpenFile } from '@/store/slices/editor'
import { translate } from '@/i18n/i18n'
import { canReloadEditorTabFromDisk, reloadEditorFileFromDisk } from './editor-disk-reload'

export function ReloadFromDiskMenuItem({ file }: { file: OpenFile }): React.JSX.Element | null {
  const shortcut = useOptionalShortcutLabel('editor.reloadFromDisk')
  if (!canReloadEditorTabFromDisk(file)) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={() => void reloadEditorFileFromDisk(file.id)}>
      <RefreshCw />
      {translate('auto.components.editor.ReloadFromDiskMenuItem.label', 'Reload from Disk')}
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}
