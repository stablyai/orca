import { translate } from '@/i18n/i18n'

export function getFolderWorkspacePrimaryActionLabel(): string {
  return translate(
    'auto.components.sidebar.FolderWorkspaceComposerDialog.create',
    'Open shared workspace'
  )
}

export function getFolderWorkspaceCheckoutNotice(): string {
  return translate(
    'auto.components.sidebar.FolderWorkspaceComposerDialog.sharedCheckoutNotice',
    'Uses the existing checkouts in this folder. Branches and file changes are shared with other workspaces; Orca does not create isolated worktrees for each repository.'
  )
}
