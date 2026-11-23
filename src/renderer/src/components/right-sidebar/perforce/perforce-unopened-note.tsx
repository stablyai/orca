import type { PerforceStatusResult } from '../../../../../shared/perforce/perforce-types'
import { translate } from '@/i18n/i18n'

/** Says why the unopened sections are missing: the first scan is running, or a sparse stream skips it. */
export function PerforceUnopenedNote({ status }: { status: PerforceStatusResult }) {
  if (!status.unopenedPending && !status.unopenedSkipped) {
    return null
  }
  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">
      {status.unopenedSkipped
        ? translate(
            'perforce.ui.sparseStreamOpenedOnly',
            'Sparse stream: only opened files are listed. Open files for edit before changing them.'
          )
        : translate('perforce.ui.scanningUnopened', 'Scanning for files changed but not opened…')}
    </div>
  )
}
