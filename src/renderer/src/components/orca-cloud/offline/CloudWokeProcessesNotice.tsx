import React, { useEffect } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { PaneTopWarningBanner } from '@/components/terminal-pane/appearance/pane-top-banner/PaneTopWarningBanner'
import { subscribePaneUserInput } from '@/components/terminal-pane/input/pane-user-input'

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

/** The strip's one action: rerun a plain shell command, or restart the pane's agent. */
export type CloudWokeAction =
  | { kind: 'rerun'; command: string }
  | { kind: 'restart'; agent: string }

/**
 * After a wake, in a pane that was running something when the workspace went to sleep: sleep is a
 * reboot, so the process is gone. A strip at the top of the pane (it reserves its height, so it
 * never covers terminal rows) says so and offers it back: Rerun for a shell command, or Restart
 * for an agent (its input box is never a command). It never acts by itself, and it goes away once
 * the person types in the pane (JA-15).
 */
export function CloudWokeProcessesNotice({
  action,
  paneLeafId,
  onAction,
  onDismiss
}: {
  action: CloudWokeAction
  /** When set, typing into this pane dismisses the strip. */
  paneLeafId?: string
  onAction: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  useEffect(() => {
    if (!paneLeafId) {
      return
    }
    return subscribePaneUserInput((paneId) => {
      if (paneId === paneLeafId) {
        onDismiss()
      }
    })
  }, [paneLeafId, onDismiss])
  return (
    <PaneTopWarningBanner
      tone="neutral"
      title={t(
        'orcaCloudWorkspace.terminal.wokeProcessesStopped',
        'Woke up · processes stopped while asleep'
      )}
      primaryAction={
        action.kind === 'rerun' ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onAction}
            title={action.command}
            aria-label={t('orcaCloudWorkspace.terminal.rerun', 'Rerun {{command}}', {
              command: action.command
            })}
            data-cloud-woke-rerun=""
          >
            <RotateCcw />
            {t('orcaCloudWorkspace.terminal.rerunLabel', 'Rerun')}
            <span className="font-mono">{truncateMiddle(action.command)}</span>
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onAction}
            data-cloud-woke-restart=""
          >
            <RotateCcw />
            {t('agentSignInStrip.restartAgent', 'Restart {{agent}}', { agent: action.agent })}
          </Button>
        )
      }
      onDismiss={onDismiss}
    />
  )
}
