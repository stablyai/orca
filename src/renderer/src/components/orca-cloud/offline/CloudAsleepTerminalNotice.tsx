import React from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { wakeCloudWorkspace } from '../cloud-workspace-actions'

/**
 * A terminal pane of an Orca Cloud workspace that is asleep (RA-12): nothing dropped and nothing to
 * retry, so a calm line and Wake instead of a reconnect toast with a "Down for" counter, or a red
 * error. The pane keeps its scrollback underneath.
 */
export function CloudAsleepTerminalNotice({
  workspaceId
}: {
  workspaceId: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      data-cloud-asleep-terminal-notice=""
      role="status"
      className="absolute inset-x-3 bottom-3 z-50 flex items-center justify-between gap-3 rounded-md border border-border bg-popover px-3.5 py-2.5 text-xs text-muted-foreground"
    >
      <span>
        {t(
          'orcaCloudWorkspace.terminal.asleepHistoryKept',
          'This workspace is asleep. Your terminal history is kept.'
        )}
      </span>
      <Button size="xs" variant="outline" onClick={() => void wakeCloudWorkspace(workspaceId)}>
        <Play />
        {t('orcaCloudWorkspace.wake', 'Wake')}
      </Button>
    </div>
  )
}
