import { defineFixture } from '../../component-fixtures/component-fixture'
import { SetupGuideSidebarEntry } from './SetupGuideSidebarEntry'

const checklist = defineFixture({
  width: 303,
  store: {
    persistedUIReady: true,
    runtimeEnvironmentCatalogSettled: true,
    setupGuideSidebarDismissed: false,
    preflightStatusChecked: true,
    preflightStatusContextKey: 'host',
    linearStatusChecked: true,
    linearStatusContextKey: 'local#0',
    jiraStatusChecked: true,
    jiraStatusContextKey: 'local#0'
  },
  setup: () => {
    window.api.skills.discover = async () => ({ skills: [], sources: [], scannedAt: 0 })
    window.api.ui.set = async () => {}
  },
  render: () => (
    <div className="bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      <SetupGuideSidebarEntry />
    </div>
  )
})

export const idle = checklist

export const active = defineFixture({
  ...checklist,
  store: { ...checklist.store, activeModal: 'setup-guide' }
})
