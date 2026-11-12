import { useId } from 'react'
import { useAppStore } from '@/store'
import { selectActiveWorkspaceDeleteTarget } from '../deletion/active-workspace-delete'
import { worktreeCopyOwnerKey } from '@/store/slices/worktrees/metadata/worktree-copy-review-clear'
import { Trash2 } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import { useIsCloudPrimaryRow, usePrimeCloudRowBindings } from '@/lib/orca-cloud/cloud-host-rows'

export function WorktreeContextMenuDeleteItems({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  const primaryDeleteDescriptionId = useId()
  const deleteShortcut = useOptionalShortcutLabel('workspace.delete')
  usePrimeCloudRowBindings()
  const {
    batchDeleteWorktrees,
    contextDeletePending,
    deleteLabel,
    folderWorkspaceId,
    handleDelete,
    isMultiContext,
    lineageDescendantCount,
    removesProject: modelRemovesProject,
    worktree
  } = model
  const isActiveDeleteTarget = useAppStore((state) => {
    const target = selectActiveWorkspaceDeleteTarget(state)
    return target?.kind === 'folder'
      ? target.workspaceKey === worktree.id && target.executionHostId === worktree.hostId
      : target?.kind === 'worktree' &&
          target.worktree.id === worktree.id &&
          worktreeCopyOwnerKey(target.worktree) === worktreeCopyOwnerKey(worktree) &&
          target.worktree.instanceId === worktree.instanceId
  })
  // An Orca Cloud workspace's own checkout is deletable: it destroys the sandbox (never "Remove Project").
  const cloudPrimary = useIsCloudPrimaryRow(worktree) && !isMultiContext
  const removesProject = !cloudPrimary && modelRemovesProject
  const projectMissing =
    !isMultiContext && !cloudPrimary && worktree.isMainWorktree && !removesProject
  const label = contextDeletePending
    ? t('auto.components.sidebar.WorktreeContextMenu.b42391d8bf', 'Deleting…')
    : isMultiContext
      ? deleteLabel
      : cloudPrimary
        ? t('auto.components.sidebar.WorktreeContextMenu.deleteCloudWorkspace', 'Delete workspace…')
        : folderWorkspaceId
          ? t('auto.components.sidebar.WorktreeContextMenu.250de158fd', 'Remove Workspace')
          : removesProject
            ? t(
                'auto.components.sidebar.WorktreeContextMenu.f5ac91531d',
                'Remove Project from Orca'
              )
            : lineageDescendantCount > 0
              ? t(
                  'auto.components.sidebar.WorktreeContextMenu.deleteWithDescendants',
                  'Delete with Descendants…'
                )
              : t('auto.components.sidebar.WorktreeContextMenu.f4475537d8', 'Delete')
  return (
    <>
      {/* Git cannot remove primary checkouts; keep disabled Delete beside the enabled Remove Project action. */}
      {!isMultiContext && removesProject ? (
        <>
          <DropdownMenuItem variant="destructive" disabled>
            <Trash2 className="size-3.5" />
            {t('auto.components.sidebar.WorktreeContextMenu.deleteWorktree', 'Delete Worktree')}
          </DropdownMenuItem>
          <p
            id={primaryDeleteDescriptionId}
            className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground"
          >
            {t(
              'auto.components.sidebar.WorktreeContextMenu.primaryDeleteDisabled',
              "Primary worktree — can't be deleted. Remove the project instead."
            )}
          </p>
        </>
      ) : null}
      {/* Use Radix’s direct title prop for project-removal copy; wrapper elements break flat roving-keyboard navigation. */}
      <DropdownMenuItem
        variant="destructive"
        aria-describedby={
          !isMultiContext && removesProject ? primaryDeleteDescriptionId : undefined
        }
        onSelect={handleDelete}
        disabled={
          contextDeletePending ||
          projectMissing ||
          (isMultiContext && batchDeleteWorktrees.length === 0)
        }
        title={
          projectMissing
            ? t(
                'auto.components.sidebar.WorktreeContextMenu.e091caab15',
                'The project could not be found'
              )
            : undefined
        }
      >
        <Trash2 className="size-3.5" />
        {label}
        {!isMultiContext && !removesProject && isActiveDeleteTarget && deleteShortcut ? (
          <DropdownMenuShortcut>{deleteShortcut}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
    </>
  )
}
