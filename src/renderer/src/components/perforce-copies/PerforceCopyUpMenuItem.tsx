import { ArrowUpFromLine } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { streamShortName } from '../../../../shared/perforce/workspace-copy/workspace-copy-name-rules'
import type { Worktree } from '../../../../shared/worktree/types'
import { getPerforceCopyUpTarget } from './perforce-copy-target'

/** Workspace-menu entry for a Perforce copy on a stream of its own; renders nothing otherwise. */
export function PerforceCopyUpMenuItem({
  worktree,
  disabled
}: {
  worktree: Pick<Worktree, 'id' | 'repoId' | 'path' | 'hostId' | 'perforceStream'>
  disabled?: boolean
}) {
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const target = getPerforceCopyUpTarget(repos, worktree)
  if (!target) {
    return null
  }
  return (
    <DropdownMenuItem
      onSelect={() => openModal('copy-up-perforce-copy', target)}
      disabled={disabled}
    >
      <ArrowUpFromLine className="size-3.5" />
      {translate('perforce.copies.copyUpTo', 'Copy Up to {{parent}}…', {
        parent: streamShortName(target.parent)
      })}
    </DropdownMenuItem>
  )
}
