import React from 'react'
import { RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/**
 * After a wake, in a pane that was running something when the workspace went to sleep: sleep is a
 * reboot, so the process is gone. One line says so and offers the command back; it never runs it
 * by itself (JA-15).
 */
export function CloudWokeProcessesNotice({
  command,
  onRerun,
  onDismiss
}: {
  command: string
  onRerun: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      data-cloud-woke-processes-notice=""
      role="status"
      className="absolute inset-x-3 bottom-3 z-50 flex items-center gap-3 rounded-md border border-border bg-popover px-3.5 py-2 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">
        {t(
          'orcaCloudWorkspace.terminal.wokeProcessesStopped',
          'Woke up · processes stopped while asleep'
        )}
      </span>
      <Button
        size="xs"
        variant="outline"
        className="min-w-0 max-w-[50%]"
        onClick={onRerun}
        title={command}
      >
        <RotateCcw />
        <span className="truncate font-mono">
          {t('orcaCloudWorkspace.terminal.rerun', 'Rerun {{command}}', { command })}
        </span>
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={onDismiss}
        aria-label={t('orcaCloudWorkspace.terminal.dismissWoke', 'Dismiss')}
      >
        <X />
      </Button>
    </div>
  )
}
