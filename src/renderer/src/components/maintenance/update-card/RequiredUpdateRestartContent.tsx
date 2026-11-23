// @protected-copy scope=file
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/updater/release-channel'
import type { TeamUpdateRestart } from '../../../../../shared/updater/update-status-types'

function RestartCountdown({ until }: { until: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((until - now) / 1000))
  return (
    <span className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

export function RequiredUpdateRestartContent({
  version,
  restart,
  onRestart
}: {
  version: string
  restart: TeamUpdateRestart
  onRestart: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('updates.teamRequired.title', 'Your team requires Orca {{version}}', { version })
  const restartNow = t('updates.teamRequired.restartNow', 'Restart now')
  if (restart.phase === 'countdown') {
    return (
      <Dialog open>
        <DialogContent
          size="confirm"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {t(
                'updates.teamRequired.countdown',
                'Orca will save your sessions and restart after the countdown. Active agents may delay the restart.'
              )}
            </DialogDescription>
          </DialogHeader>
          <p className="text-lg font-semibold">
            <RestartCountdown key={restart.countdownEndsAt} until={restart.countdownEndsAt} />
          </p>
          <DialogFooter>
            <Button onClick={onRestart}>{restartNow}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
  const summary =
    restart.phase === 'waiting-for-agents'
      ? t('updates.teamRequired.waiting', 'Orca is waiting for active agents before restarting.')
      : restart.phase === 'retry-next-launch'
        ? t('updates.teamRequired.retry', 'Orca will retry this update the next time it starts.')
        : restart.phase === 'manual'
          ? t(
              'updates.teamRequired.manual',
              'Automatic installation failed. Install this update manually.'
            )
          : t(
              'updates.teamRequired.deadline',
              'Restart by {{deadline}}. Orca saves your sessions before restarting.',
              {
                deadline: new Date(restart.deadlineAt).toLocaleString(getIntlLocale(), {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })
              }
            )
  return (
    <div className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{summary}</p>
      <div className="flex justify-end gap-2">
        {restart.phase === 'manual' ? (
          <Button asChild size="sm">
            <a href={getReleaseNotesUrlForVersion(version)} target="_blank" rel="noreferrer">
              {t('updates.teamRequired.download', 'Open downloads')}
            </a>
          </Button>
        ) : (
          <>
            {restart.phase === 'ready' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void window.api.updater
                    .snoozeRequiredUpdate()
                    .catch((error) => console.warn('[updater] Could not defer the restart:', error))
                }}
              >
                {t('updates.installBlock.later', 'Later')}
              </Button>
            )}
            <Button size="sm" onClick={onRestart}>
              {restartNow}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
