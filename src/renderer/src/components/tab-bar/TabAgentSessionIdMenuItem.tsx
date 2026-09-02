import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

async function copySessionId(sessionId: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(sessionId)
    toast.success(
      translate(
        'components.tab.bar.SortableTabContextMenu.copySessionIdSuccess',
        'Session ID copied'
      )
    )
  } catch {
    toast.error(
      translate(
        'components.tab.bar.SortableTabContextMenu.copySessionIdError',
        'Failed to copy Session ID'
      )
    )
  }
}

/** Copies the active pane's provider session id when one is available. */
export function TabAgentSessionIdMenuItem({
  sessionId
}: {
  sessionId: string | null
}): React.JSX.Element | null {
  if (sessionId === null) {
    return null
  }
  const label = translate(
    'components.tab.bar.SortableTabContextMenu.copySessionId',
    'Copy Session ID'
  )
  return (
    <DropdownMenuItem
      onSelect={() => {
        void copySessionId(sessionId)
      }}
    >
      <Copy className="size-3.5" />
      {label}
    </DropdownMenuItem>
  )
}
