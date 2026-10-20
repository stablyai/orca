import { ArrowUpFromLine } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { streamShortName } from '../../../../shared/perforce/workspace-copy/workspace-copy-name-rules'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getPerforceCopyUpTarget } from './perforce-copy-target'

/** Workspace-menu entry for a Perforce copy on a stream of its own; renders nothing otherwise. */
export function PerforceCopyUpMenuItem({
  repo,
  worktree,
  disabled
}: {
  repo: Repo | null | undefined
  worktree: Pick<Worktree, 'id' | 'path' | 'perforceStream'>
  disabled?: boolean
}) {
  const openModal = useAppStore((s) => s.openModal)
  const target = getPerforceCopyUpTarget(repo, worktree)
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
