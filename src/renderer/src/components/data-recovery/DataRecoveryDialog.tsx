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
import { translate } from '@/i18n/i18n'
import type { RecoveryPointDto } from '../../../../shared/data-recovery'

export type DataRecoveryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** `restorable` is optional so a host that predates the readability probe still
 *  lists its points; only an explicit `false` withdraws the restore affordance. */
function isRestorable(point: RecoveryPointDto): boolean {
  return point.restorable !== false
}

function pointTitle(point: RecoveryPointDto): string {
  switch (point.id) {
    case 'agent-catalog-pre-v1':
      return translate(
        'auto.components.dataRecovery.pointAgentCatalogPreV1Title',
        'Before custom agents'
      )
  }
}

function pointLossSummary(point: RecoveryPointDto): string {
  switch (point.id) {
    case 'agent-catalog-pre-v1':
      return translate(
        'auto.components.dataRecovery.pointAgentCatalogPreV1Loss',
        'This discards settings and custom agents saved after this update.'
      )
  }
}

/** Main-owned restore flow (runbook: General Data recovery UI). Lists recovery
 *  points by metadata only; the pinned pre-v1 point restores via Prepare
 *  downgrade — Orca restores atomically and quits without relaunching. */
export function DataRecoveryDialog({ open, onOpenChange }: DataRecoveryDialogProps) {
  const [points, setPoints] = useState<RecoveryPointDto[] | null>(null)
  const [confirming, setConfirming] = useState<RecoveryPointDto | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restored, setRestored] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setConfirming(null)
      setError(null)
      return
    }
    let cancelled = false
    void window.api.dataRecovery
      ?.listPoints()
      .then((list) => {
        if (!cancelled) {
          setPoints(list)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPoints([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const handleRestore = async (point: RecoveryPointDto): Promise<void> => {
    setRestoring(true)
    setError(null)
    try {
      const result = await window.api.dataRecovery?.restore({
        id: point.id,
        mode: 'prepare-downgrade'
      })
      if (result && !result.ok) {
        setError(result.error)
        return
      }
      // A committed restore replaced the profile and suspended writes, so this
      // window is no longer saving anything. Orca quits right after; say so
      // rather than leave a silent dialog if that quit is ever delayed.
      setRestored(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoring(false)
    }
  }

  if (restored) {
    // Terminal state: not dismissible, because there is nothing to go back to —
    // the profile on disk is the recovery point and this window saves nothing.
    return (
      <Dialog open>
        <DialogContent className="max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.dataRecovery.restoredTitle', 'Restored — quitting Orca')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.dataRecovery.restoredBody',
                'The recovery point was restored and Orca is quitting. This window no longer saves changes, so anything you do here from now on is discarded. If Orca does not quit on its own, quit it yourself, then install the previous Orca version before opening it again.'
              )}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.dataRecovery.title', 'Data recovery')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.dataRecovery.description',
              'Restore the settings Orca saved before this update. The saved copy is kept.'
            )}
          </DialogDescription>
        </DialogHeader>

        {points === null ? (
          <p className="text-sm text-muted-foreground">
            {translate('auto.components.dataRecovery.loading', 'Looking for recovery points…')}
          </p>
        ) : points.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.dataRecovery.empty',
              'No recovery points exist for this profile.'
            )}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {points.map((point) => (
              <li key={point.id} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium">{pointTitle(point)}</p>
                <p className="text-muted-foreground">
                  {point.createdAtMs
                    ? translate('auto.components.dataRecovery.createdAt', 'Created {{date}}', {
                        date: new Date(point.createdAtMs).toLocaleString()
                      })
                    : translate(
                        'auto.components.dataRecovery.createdUnknown',
                        'Creation time unknown'
                      )}
                </p>
                {point.compatibility === 'previous-binary' && isRestorable(point) ? (
                  <p className="text-muted-foreground">
                    {translate(
                      'auto.components.dataRecovery.previousBinary',
                      'After restoring, Orca quits. Install the previous Orca version before opening it again.'
                    )}
                  </p>
                ) : null}
                {!isRestorable(point) ? (
                  <p className="mt-1 text-destructive">
                    {translate(
                      'auto.components.dataRecovery.unreadable',
                      'This recovery point cannot be read, so it cannot be restored. Check its file permissions, or move whatever now occupies its path, then reopen Data recovery.'
                    )}
                  </p>
                ) : (
                  <p className="mt-1 text-muted-foreground">{pointLossSummary(point)}</p>
                )}
                {!isRestorable(point) ? null : confirming?.id === point.id ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="xs"
                      disabled={restoring}
                      onClick={() => void handleRestore(point)}
                    >
                      {restoring
                        ? translate('auto.components.dataRecovery.restoring', 'Restoring…')
                        : translate(
                            'auto.components.dataRecovery.confirmRestore',
                            'Restore and quit'
                          )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={restoring}
                      onClick={() => setConfirming(null)}
                    >
                      {translate('auto.components.dataRecovery.cancel', 'Cancel')}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="mt-2"
                    onClick={() => setConfirming(point)}
                  >
                    {translate(
                      'auto.components.dataRecovery.prepareDowngrade',
                      'Restore these settings…'
                    )}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" className="break-words text-sm text-destructive">
            {translate(
              'auto.components.dataRecovery.restoreFailed',
              'Restore failed and no changes were made: {{error}}',
              { error }
            )}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.dataRecovery.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
