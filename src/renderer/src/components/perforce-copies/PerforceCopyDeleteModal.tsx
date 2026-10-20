import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { PerforceCopyDeleteDialog } from './PerforceCopyDeleteDialog'
import type { PerforceCopyDeleteTarget } from './perforce-copy-target'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'

function readTarget(data: Record<string, unknown>): PerforceCopyDeleteTarget | null {
  const { repoId, sourcePath, copyName } = data
  const host = typeof data.hostId === 'string' ? parseExecutionHostId(data.hostId) : null
  return typeof repoId === 'string' &&
    typeof sourcePath === 'string' &&
    typeof copyName === 'string' &&
    host
    ? { repoId, hostId: host.id, sourcePath, copyName }
    : null
}

/** The `delete-perforce-copy` modal, opened from any sidebar delete of a Perforce copy. */
export default function PerforceCopyDeleteModal() {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const target = readTarget(modalData)
  return (
    <PerforceCopyDeleteDialog
      target={target}
      onClose={closeModal}
      onDeleted={(result) => {
        toast.success(
          translate('perforce.copies.deleted', 'Deleted Perforce copy {{name}}', {
            name: result.name
          }),
          {
            description: result.note ?? undefined
          }
        )
      }}
    />
  )
}
