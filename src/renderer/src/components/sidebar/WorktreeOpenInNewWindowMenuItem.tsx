import { AppWindow } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import { openRuntimeClientWindowFromRenderer } from '@/lib/open-runtime-client-window'

/** Opens a git worktree or folder workspace in an extra desktop window; absent in web clients. */
export function WorktreeOpenInNewWindowMenuItem({
  worktreeId,
  disabled
}: {
  worktreeId: string
  disabled: boolean
}): React.JSX.Element | null {
  // Why: only the desktop main process can open a window, so a web client has nothing to offer.
  if (isWebClientLocation()) {
    return null
  }
  return (
    <DropdownMenuItem
      onSelect={() => void openRuntimeClientWindowFromRenderer(worktreeId)}
      disabled={disabled}
    >
      <AppWindow className="size-3.5" />
      {translate('multiWindow.openInNewWindow', 'Open in New Window')}
    </DropdownMenuItem>
  )
}
