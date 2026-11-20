import { GITLAB_DIALOG_FORGE } from './gitlab-dialog-forge'
import { ForgeItemDialog } from './forge-item-dialog'
import type { GitLabItemDialogProps } from './gitlab-item-dialog-types'

export default function GitLabItemDialog(props: GitLabItemDialogProps) {
  return <ForgeItemDialog forge={GITLAB_DIALOG_FORGE} {...props} />
}
