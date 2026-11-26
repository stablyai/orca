import { toast } from 'sonner'
import type { PerforceCopyCreateSummary } from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import { translate } from '@/i18n/i18n'

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** Where the copy is and what it cost, from the engine's measurements only. */
export function describeCreatedCopy(copy: PerforceCopyCreateSummary): string {
  const { space } = copy
  const cost =
    space.cloned === true && space.copiedBytes !== null
      ? translate(
          'perforce.copies.blockClonedCost',
          'Block-cloned {{copied}} of files using {{used}} of disk.',
          { copied: gb(space.copiedBytes), used: gb(space.usedBytes) }
        )
      : translate('perforce.copies.usedCost', 'Used {{used}} of disk.', {
          used: gb(space.usedBytes)
        })
  return [
    translate('perforce.copies.createdWhere', '{{folder}} on {{stream}} ({{reason}}).', {
      folder: copy.copyRoot,
      stream: copy.stream,
      reason: copy.streamChoice
    }),
    cost,
    ...copy.warnings
  ].join(' ')
}

/** After Create workspace made a Perforce copy: its cost, warnings and the Unity binding line. */
export function announcePerforceCopy(copy: PerforceCopyCreateSummary | undefined): void {
  if (!copy) {
    return
  }
  const binding = copy.unityVersionControlBinding
  toast.success(
    translate('perforce.copies.ready', 'Perforce copy {{name}} is ready', { name: copy.name }),
    {
      description: describeCreatedCopy(copy),
      duration: 20_000,
      closeButton: true,
      ...(binding
        ? {
            action: {
              label: translate('perforce.copies.copyUnityLine', 'Copy Unity line'),
              onClick: () => void navigator.clipboard.writeText(binding)
            }
          }
        : {})
    }
  )
}
