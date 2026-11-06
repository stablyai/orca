import { defineFixture } from '@/component-fixtures/component-fixture'
import { WorkspaceFilterOptionRow } from './workspace-filter-option-row'
import { WORKSPACE_VIEW_OPTIONS } from '../../../../../../shared/workspace-view/workspace-view-options'

export const hideEmptyProjects = defineFixture({
  width: 300,
  store: { hideEmptyProjects: true },
  render: () => (
    <div className="h-24 bg-popover p-2">
      <WorkspaceFilterOptionRow optionKey="hideSleepingWorkspaces" />
      {WORKSPACE_VIEW_OPTIONS.some((option) => option.key === 'hideEmptyProjects') && (
        <WorkspaceFilterOptionRow optionKey="hideEmptyProjects" />
      )}
    </div>
  )
})
