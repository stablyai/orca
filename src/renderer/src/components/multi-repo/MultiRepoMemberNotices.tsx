import React from 'react'
import { Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { resolveMultiRepoExecutionHostId } from '@/lib/multi-repo-execution-host'
import { translate } from '@/i18n/i18n'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { findMultiRepoMemberByWorktreeId } from '@/store/slices/multi-repo-workspace/multi-repo-workspace-selectors'

const NO_FOLDER_WORKSPACES: readonly FolderWorkspace[] = []

function useMemberOf(worktreeId: string) {
  // These notices render inside dialogs and menus that run with partial store snapshots in tests.
  const folderWorkspaces = useAppStore(
    (state) => selectFolderWorkspaces(state) ?? NO_FOLDER_WORKSPACES
  )
  return React.useMemo(
    () => findMultiRepoMemberByWorktreeId(folderWorkspaces, worktreeId),
    [folderWorkspaces, worktreeId]
  )
}

/** "Only deletes web. The workspace keeps 2 repos." for a delete that targets one member. */
export function MultiRepoMemberDeleteNote({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const found = useMemberOf(worktreeId)
  const repos = useAppStore((state) => state.repos)
  const multiRepo = found?.workspace.multiRepo
  if (!found || !multiRepo) {
    return null
  }
  const name =
    repos.find((repo) => repo.id === found.member.repoId)?.displayName ?? found.member.dirName
  const keeps = multiRepo.members.filter((member) => member.memberId !== found.member.memberId)
  return (
    <p className="text-xs text-muted-foreground">
      {keeps.length === 1
        ? translate(
            'auto.components.multiRepo.memberDelete.keepsOne',
            'Only deletes {{name}}. The workspace keeps 1 repo.',
            { name }
          )
        : translate(
            'auto.components.multiRepo.memberDelete.keepsMany',
            'Only deletes {{name}}. The workspace keeps {{n}} repos.',
            { name, n: keeps.length }
          )}
    </p>
  )
}

/** Context-menu entry for a member row: detach it to a top-level worktree, with Undo. */
export function RemoveFromWorkspaceMenuItem({
  worktreeId,
  disabled
}: {
  worktreeId: string
  disabled?: boolean
}): React.JSX.Element | null {
  const found = useMemberOf(worktreeId)
  const runMemberAction = useAppStore((state) => state.runMultiRepoMemberAction)
  const repos = useAppStore((state) => state.repos)
  if (!found?.workspace.multiRepo) {
    return null
  }
  const { workspace, member } = found
  const executionHostId = resolveMultiRepoExecutionHostId(workspace)
  const args = {
    folderWorkspaceId: workspace.id,
    memberId: member.memberId,
    ...(executionHostId ? { executionHostId } : {})
  }
  const name = repos.find((repo) => repo.id === member.repoId)?.displayName ?? member.dirName
  const handleSelect = (): void => {
    void runMemberAction('detachMember', args)
      .then(() => {
        toast(
          translate(
            'auto.components.multiRepo.removeFromWorkspace.done',
            '{{name}} left {{workspace}}',
            {
              name,
              workspace: workspace.name
            }
          ),
          {
            action: {
              label: translate('auto.components.multiRepo.removeFromWorkspace.undo', 'Undo'),
              onClick: () => {
                void runMemberAction('attachMember', args).catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error))
                )
              }
            }
          }
        )
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
  }
  return (
    <DropdownMenuItem onSelect={handleSelect} disabled={disabled}>
      <Unlink className="size-3.5" />
      {translate('auto.components.multiRepo.root.removeFromWorkspace', 'Remove from workspace')}
    </DropdownMenuItem>
  )
}
