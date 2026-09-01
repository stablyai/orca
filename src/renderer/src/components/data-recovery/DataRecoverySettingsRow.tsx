import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { DataRecoveryDialog } from './DataRecoveryDialog'

/** Settings-side entry into Data recovery (runbook: downgrade step 1 offers
 *  "the app-level migration notice or Settings"). Renders nothing when no
 *  recovery point exists or the surface is absent (paired web). */
export function DataRecoverySettingsRow() {
  const [hasPoints, setHasPoints] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.dataRecovery
      ?.listPoints()
      .then((points) => {
        if (!cancelled) {
          setHasPoints(points.length > 0)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!hasPoints) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>
        {translate(
          'auto.components.dataRecovery.settingsRowHint',
          'You can restore the settings from before this update, then install the previous Orca.'
        )}
      </span>
      <Button type="button" variant="outline" size="xs" onClick={() => setOpen(true)}>
        {translate('auto.components.dataRecovery.settingsRowOpen', 'Data recovery…')}
      </Button>
      <DataRecoveryDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}
