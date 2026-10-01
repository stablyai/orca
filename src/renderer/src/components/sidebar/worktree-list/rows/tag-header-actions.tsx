import React from 'react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useWorkspaceTagCommands } from '../../use-workspace-tag-commands'
import { openTagRenameDialog } from '../../TagRenameDialogHost'
import { ProjectGroupHeaderMenu } from './project-group-header-actions'

/** Rename or delete a tag everywhere it is used; deleting never touches the workspaces themselves. */
export function TagHeaderMenu({ tag }: { tag: string }): React.JSX.Element {
  const { deleteTag, countTagged } = useWorkspaceTagCommands()
  const confirm = useConfirmationDialog()

  const handleDelete = async (): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'auto.components.sidebar.tagHeader.deleteTitle',
        'Delete tag “{{value0}}”?',
        { value0: tag }
      ),
      description: translate(
        'auto.components.sidebar.tagHeader.deleteDescription',
        'The tag is removed from {{value0}} workspace(s). The workspaces themselves are not changed.',
        { value0: countTagged(tag) }
      ),
      confirmLabel: translate('auto.components.sidebar.tagHeader.deleteConfirm', 'Delete tag'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      // Planned when the queued write runs, so workspaces tagged while the dialog was open are included.
      await deleteTag(tag)
    }
  }

  return (
    <ProjectGroupHeaderMenu
      groupId={tag}
      label={tag}
      onRename={() => openTagRenameDialog(tag)}
      onDelete={() => void handleDelete()}
      copy={{
        actionsLabel: translate(
          'auto.components.sidebar.tagHeader.actions',
          'Tag actions for {{value0}}',
          { value0: tag }
        ),
        renameLabel: translate('auto.components.sidebar.tagHeader.rename', 'Rename tag'),
        deleteLabel: translate('auto.components.sidebar.tagHeader.delete', 'Delete tag')
      }}
    />
  )
}
