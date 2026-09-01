import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

async function copySessionId(sessionId: string): Promise<void> {
  const label = translate('components.tab.bar.SortableTabContextMenu.sessionId', 'Session ID')
  try {
    await window.api.ui.writeClipboardText(sessionId)
    toast.success(
      translate('auto.components.JiraIssueWorkspace.2ff69a3545', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.JiraIssueWorkspace.6c41a9bcea', 'Failed to copy {{value0}}', {
        value0: label.toLowerCase()
      })
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
