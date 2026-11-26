import React from 'react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import { useWorkspaceTagCommands } from '../../workspace-tags/use-workspace-tag-commands'
import { openTagRenameDialog } from '../../workspace-tags/TagRenameDialogHost'
import { ProjectGroupHeaderMenu } from './project-group-header-actions'

/** Rename or delete a tag everywhere it is used; deleting never touches the workspaces themselves. */
export function TagHeaderMenu({ tag }: { tag: string }): React.JSX.Element {
  const t = useTranslate()
  const { deleteTag, countTagged } = useWorkspaceTagCommands()
  const confirm = useConfirmationDialog()

  const handleDelete = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('auto.components.sidebar.tagHeader.deleteTitle', 'Delete tag “{{value0}}”?', {
        value0: tag
      }),
      description: t(
        'auto.components.sidebar.tagHeader.deleteDescription',
        'The tag is removed from {{value0}} workspace(s). The workspaces themselves are not changed.',
        { value0: countTagged(tag) }
      ),
      confirmLabel: t('auto.components.sidebar.tagHeader.deleteConfirm', 'Delete tag'),
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
      projectGroup={null}
      onRename={() => openTagRenameDialog(tag)}
      onDelete={() => void handleDelete()}
      copy={{
        actionsLabel: t('auto.components.sidebar.tagHeader.actions', 'Tag actions for {{value0}}', {
          value0: tag
        }),
        renameLabel: t('auto.components.sidebar.tagHeader.rename', 'Rename tag'),
        deleteLabel: t('auto.components.sidebar.tagHeader.delete', 'Delete tag')
      }}
    />
  )
}
