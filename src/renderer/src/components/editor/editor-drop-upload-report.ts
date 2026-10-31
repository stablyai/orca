import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { describeSharedDropFailureReason } from '@/lib/drop-skip-reason-copy'
import type { ImportItemResult } from '../../../../shared/filesystem-import-result-types'

export function reportEditorDropUploadRejections(results: readonly ImportItemResult[]): void {
  const rejected = results
    .filter((result) => result.status !== 'imported')
    // A cancel is the user's own decision, not a failure to report back.
    .filter((result) => result.status === 'skipped' || result.cancelled !== true)
  if (rejected.length > 0) {
    toast.error(
      translate(
        'auto.hooks.useGlobalFileDrop.d720e2f855',
        'Some dropped files could not be uploaded.'
      ),
      { description: describeSharedDropFailureReason(rejected) }
    )
  }
}
