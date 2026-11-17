import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import {
  RepoHeaderProjectActionsMenu,
  type RepoHeaderProjectActions
} from './repo-header-project-actions'
import type { Repo } from '../../../../../../shared/repository/repo-types'

const repo: Repo = {
  id: 'orca',
  path: '/Users/alice/orca',
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git',
  executionHostId: 'local'
}

const actions: RepoHeaderProjectActions = {
  getWorktreeVisibilityDefaults: () => undefined,
  onOpenRepoSettings: () => undefined,
  onRenameProject: () => undefined,
  onOpenWorktreeVisibility: () => undefined,
  onCreateGroupFromRepo: () => undefined,
  onMoveProjectToGroup: () => undefined,
  onRemoveProjectFromGroup: () => undefined,
  onRemoveProject: () => undefined,
  onCreateForRepo: () => undefined
}

const confirm = async (): Promise<boolean> => false

export const projectMenu = defineFixture({
  width: 280,
  render: () => (
    <ConfirmationDialogContext.Provider value={confirm}>
      <div className="rounded-lg border border-border bg-sidebar p-3">
        <div className="flex items-center justify-between rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5">
          <span className="text-xs font-semibold text-foreground">orca</span>
          <RepoHeaderProjectActionsMenu
            repo={repo}
            label="orca"
            projectGroups={[]}
            actions={actions}
          />
        </div>
      </div>
    </ConfirmationDialogContext.Provider>
  ),
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLButtonElement>('[data-repo-header-action]')
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
})
