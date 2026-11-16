import React, { useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { ProjectGroupNameDialog } from '../worktree-list/rows/ProjectGroupNameDialog'
import { useWorkspaceTagCommands } from './use-workspace-tag-commands'
import { stopRepoHeaderMenuEvent } from '../worktree-list/rows/header-event-guards'

let renamingTag: string | null = null
const listeners = new Set<() => void>()

function setRenamingTag(tag: string | null): void {
  renamingTag = tag
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Opens the list-level rename dialog; headers are virtualized and may unmount mid-edit. */
export function openTagRenameDialog(tag: string): void {
  setRenamingTag(tag)
}

export function TagRenameDialogHost(): React.JSX.Element {
  const t = useTranslate()
  const tag = useSyncExternalStore(
    subscribe,
    () => renamingTag,
    () => null
  )
  const { renameTag } = useWorkspaceTagCommands()
  return (
    // Why: dialog events bubble through React ancestors; keep Space/Enter from reaching list handlers.
    <div
      className="contents"
      onKeyDown={stopRepoHeaderMenuEvent}
      onPointerDown={stopRepoHeaderMenuEvent}
      onMouseDown={stopRepoHeaderMenuEvent}
      onClick={stopRepoHeaderMenuEvent}
    >
      <ProjectGroupNameDialog
        open={tag !== null}
        title={t('auto.components.sidebar.tagHeader.renameTitle', 'Rename Tag')}
        description={t(
          'auto.components.sidebar.tagHeader.renameDescription',
          'Renames the tag on every workspace that has it. Using an existing name merges the two tags.'
        )}
        initialName={tag ?? ''}
        confirmLabel={t('auto.components.sidebar.tagHeader.renameConfirm', 'Rename')}
        nameLabel={t('auto.components.sidebar.tagHeader.nameLabel', 'Tag Name')}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingTag(null)
          }
        }}
        onSubmit={async (name) => {
          if (tag !== null) {
            await renameTag(tag, name)
          }
          setRenamingTag(null)
        }}
      />
    </div>
  )
}
