import React from 'react'
import { FolderTree } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { buildRootPanelModel } from './root-panel-model'
import { getRootPanelHeaderText } from './root-panel-copy'

/**
 * Chip on a multi-repo parent row: the repo count with every attention state spelled out, plus the
 * aggregate change count so a collapsed workspace still answers "does any repo have work?".
 * Renders nothing for plain folder workspaces.
 */
export default function MultiRepoRowBadge({
  folderWorkspace
}: {
  folderWorkspace: FolderWorkspace
}): React.JSX.Element | null {
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => selectWorktreesByRepo(state))
  const gitStatusByWorktree = useAppStore((state) => state.gitStatusByWorktree)
  const model = React.useMemo(
    () => buildRootPanelModel({ folderWorkspace, repos, worktreesByRepo, gitStatusByWorktree }),
    [folderWorkspace, repos, worktreesByRepo, gitStatusByWorktree]
  )
  if (!model) {
    return null
  }
  const { summary } = model
  // The "with changes" part is the aggregate below; the chip keeps count and problem states.
  const chipText = getRootPanelHeaderText({ ...summary, withChanges: 0 })
  return (
    <span className="inline-flex items-center gap-1.5">
      {summary.changed > 0 ? (
        <span className="text-[11px] text-muted-foreground">
          {translate('auto.components.multiRepo.strip.changed', '{{n}} changed', {
            n: summary.changed
          })}
        </span>
      ) : null}
      <Badge variant="hostContext">
        <FolderTree aria-hidden="true" className="size-3" />
        {chipText}
      </Badge>
    </span>
  )
}
