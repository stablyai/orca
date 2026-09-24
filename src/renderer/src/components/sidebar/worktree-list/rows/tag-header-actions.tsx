import React, { useState } from 'react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { useWorkspaceTagCommands } from '../../workspace-tags/use-workspace-tag-commands'
import { ProjectGroupHeaderMenu } from './project-group-header-actions'

/** Rename or delete a tag everywhere it is used; deleting never touches the workspaces themselves. */
export function TagHeaderMenu({ tag }: { tag: string }): React.JSX.Element {
  const { renameTag, deleteTag, countTagged } = useWorkspaceTagCommands()
  const confirm = useConfirmationDialog()
  const [renaming, setRenaming] = useState(false)

  const handleDelete = async (): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'auto.components.sidebar.tagHeader.deleteTitle',
        'Delete tag “{{value0}}”?',
        {
          value0: tag
        }
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
      await deleteTag(tag)
    }
  }

  return (
    <>
      <ProjectGroupHeaderMenu
        groupId={tag}
        label={tag}
        onRename={() => setRenaming(true)}
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
      <ProjectGroupNameDialog
        open={renaming}
        title={translate('auto.components.sidebar.tagHeader.renameTitle', 'Rename Tag')}
        description={translate(
          'auto.components.sidebar.tagHeader.renameDescription',
          'Renames the tag on every workspace that has it. Using an existing name merges the two tags.'
        )}
        initialName={tag}
        confirmLabel={translate('auto.components.sidebar.tagHeader.renameConfirm', 'Rename')}
        nameLabel={translate('auto.components.sidebar.tagHeader.nameLabel', 'Tag Name')}
        onOpenChange={setRenaming}
        onSubmit={async (name) => {
          await renameTag(tag, name)
          setRenaming(false)
        }}
      />
    </>
  )
}
