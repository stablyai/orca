import React from 'react'
import { PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { JiraProjectPicker } from '../../task-page/jira/project-selection/jira-project-picker'
import { LinearWorkspacePicker } from '../../task-page/source-selection/linear-workspace-picker'
import { SmartWorkspaceSourceResultList } from '../source-search/SmartWorkspaceSourceResultList'
import type { SmartWorkspaceNameFieldController } from './use-smart-workspace-name-field-controller'

export function renderSmartWorkspaceSourceResults(
  controller: SmartWorkspaceNameFieldController,
  t: Translate = translate
): React.JSX.Element {
  const { disabled, localInputRef, mode, tabsListRef } = controller

  return (
    <PopoverContent
      data-workspace-source-suggestions="true"
      align="start"
      side="bottom"
      sideOffset={6}
      avoidCollisions={false}
      className="popover-scroll-content flex w-[var(--radix-popover-trigger-width)] flex-col p-0"
      onOpenAutoFocus={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => {
        // Input/mode tabs are anchors outside Radix content; interacting with them must keep results open.
        const target = event.target as Node
        if (localInputRef.current?.contains(target) || tabsListRef.current?.contains(target)) {
          event.preventDefault()
        }
      }}
      onFocusOutside={(event) => {
        const target = event.target as Node
        if (localInputRef.current?.contains(target) || tabsListRef.current?.contains(target)) {
          event.preventDefault()
        }
      }}
    >
      {mode === 'jira' ? (
        <div
          className="flex min-w-0 shrink-0 items-center border-b border-border/40 px-2 py-1.5"
          onMouseDown={(event) => event.preventDefault()}
        >
          <JiraProjectPicker
            projects={controller.jiraProjectInventory.projects}
            value={controller.jiraProject}
            onChange={controller.setJiraProject}
            label={t('components.jiraProjectPicker.label', 'Jira project')}
            emptyLabel={t('components.jiraProjectPicker.all', 'All Jira projects')}
            disabled={disabled || controller.jiraProjectInventory.loading}
            size="xs"
            returnFocusRef={localInputRef}
          />
        </div>
      ) : mode === 'linear' ? (
        <div
          className="flex min-w-0 shrink-0 items-center border-b border-border/40 px-2 py-1.5"
          onMouseDown={(event) => event.preventDefault()}
        >
          <LinearWorkspacePicker
            workspaces={controller.linearStatus.workspaces ?? []}
            value={controller.linearWorkspaceIdOverride}
            onChange={controller.setLinearWorkspaceId}
            disabled={disabled || !controller.linearStatusChecked}
            size="xs"
            returnFocusRef={localInputRef}
          />
        </div>
      ) : null}
      <SmartWorkspaceSourceResultList model={controller} onSelect={controller.handleSelect} />
    </PopoverContent>
  )
}
