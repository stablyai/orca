import { Layers } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isPerforceRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'

/** Project-menu entry for a Perforce project; its copies are made with Create workspace. */
export function PerforceCopyMenuItems({ repo }: { repo: Repo }) {
  const openModal = useAppStore((s) => s.openModal)
  if (!isPerforceRepo(repo)) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() =>
          openModal('perforce-copies', { repoId: repo.id, hostId: getRepoExecutionHostId(repo) })
        }
      >
        <Layers className="size-3.5" />
        {translate('perforce.copies.manage', 'Manage Perforce copies…')}
      </DropdownMenuItem>
    </>
  )
}
