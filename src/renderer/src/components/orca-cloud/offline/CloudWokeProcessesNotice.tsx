import React, { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { PaneTopWarningBanner } from '@/components/terminal-pane/appearance/pane-top-banner/PaneTopWarningBanner'
import { paneHadUserInputSince } from '@/components/terminal-pane/input/pane-user-input'

const MAX_COMMAND_CHARS = 48

/** "python3 -m http…server 8000": keeps both ends of a long command readable. */
export function truncateMiddle(text: string, max = MAX_COMMAND_CHARS): string {
  if (text.length <= max) {
    return text
  }
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/**
 * After a wake, in a pane that was running something when the workspace went to sleep: sleep is a
 * reboot, so the process is gone. A strip at the top of the pane (it reserves its height, so it
 * never covers terminal rows) says so and offers the command back; it never runs it by itself, and
 * it goes away once the person types in the pane (JA-15).
 */
export function CloudWokeProcessesNotice({
  command,
  paneLeafId,
  onRerun,
  onDismiss
}: {
  command: string
  /** When set, typing into this pane dismisses the strip. */
  paneLeafId?: string
  onRerun: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [shownAt] = useState(() => Date.now())
  useEffect(() => {
    if (!paneLeafId) {
      return
    }
    const timer = setInterval(() => {
      if (paneHadUserInputSince(paneLeafId, shownAt)) {
        onDismiss()
      }
    }, 500)
    return () => clearInterval(timer)
  }, [paneLeafId, shownAt, onDismiss])
  return (
    <PaneTopWarningBanner
      tone="neutral"
      title={t(
        'orcaCloudWorkspace.terminal.wokeProcessesStopped',
        'Woke up · processes stopped while asleep'
      )}
      primaryAction={
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={onRerun}
          title={command}
          aria-label={t('orcaCloudWorkspace.terminal.rerun', 'Rerun {{command}}', { command })}
          data-cloud-woke-rerun=""
        >
          <RotateCcw />
          {t('orcaCloudWorkspace.terminal.rerunLabel', 'Rerun')}
          <span className="font-mono">{truncateMiddle(command)}</span>
        </Button>
      }
      onDismiss={onDismiss}
    />
  )
}
