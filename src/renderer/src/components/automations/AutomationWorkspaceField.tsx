import { Info } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { AutomationWorkspaceMode } from '../../../../shared/automations-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from './automation-page-parts'
import { CreateFromPicker } from './CreateFromPicker'
import { WorkspaceCombobox } from './WorkspaceCombobox'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationWorkspaceFieldProps = {
  draft: AutomationDraft
  isHermesTarget: boolean
  worktrees: Worktree[]
  repoMap: Map<string, Repo>
  pickerTriggerClassName: string
  segmentedGroupClassName: string
  segmentedItemClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationWorkspaceField({
  draft,
  isHermesTarget,
  worktrees,
  repoMap,
  pickerTriggerClassName,
  segmentedGroupClassName,
  segmentedItemClassName,
  onDraftChange
}: AutomationWorkspaceFieldProps): React.JSX.Element {
  return (
    <Field
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={
        <span className="inline-flex items-center gap-1">
          {translate('auto.components.automations.AutomationEditorDialog.b28b140eaf', 'Workspace')}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={translate(
                  'auto.components.automations.AutomationEditorDialog.2c3fd9bfa1',
                  'Workspace mode help'
                )}
                className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-72">
              {translate(
                'auto.components.automations.AutomationEditorDialog.6f9610e667',
                'Worktree runs in the selected workspace. New run creates a fresh workspace from the selected branch each time.'
              )}
            </TooltipContent>
          </Tooltip>
        </span>
      }
    >
      {isHermesTarget ? (
        <WorkspaceCombobox
          worktrees={worktrees}
          value={draft.workspaceId}
          triggerClassName={pickerTriggerClassName}
          onValueChange={(workspaceId) => onDraftChange((current) => ({ ...current, workspaceId }))}
        />
      ) : (
        <div className="grid gap-2">
          <ToggleGroup
            type="single"
            spacing={1}
            value={draft.workspaceMode}
            onValueChange={(workspaceMode) =>
              workspaceMode &&
              onDraftChange((current) => ({
                ...current,
                workspaceMode: workspaceMode as AutomationWorkspaceMode,
                reuseSession: workspaceMode === 'existing' ? current.reuseSession : false
              }))
            }
            size="sm"
            className={segmentedGroupClassName}
          >
            <ToggleGroupItem value="existing" className={segmentedItemClassName}>
              {translate(
                'auto.components.automations.AutomationEditorDialog.a2e688226d',
                'Worktree'
              )}
            </ToggleGroupItem>
            <ToggleGroupItem value="new_per_run" className={segmentedItemClassName}>
              {translate(
                'auto.components.automations.AutomationEditorDialog.6ff66f9012',
                'New run'
              )}
            </ToggleGroupItem>
          </ToggleGroup>
          {draft.workspaceMode === 'existing' ? (
            <WorkspaceCombobox
              worktrees={worktrees}
              value={draft.workspaceId}
              triggerClassName={`min-w-0 ${pickerTriggerClassName}`}
              onValueChange={(workspaceId) =>
                onDraftChange((current) => ({ ...current, workspaceId }))
              }
            />
          ) : (
            <CreateFromPicker
              // Why: branch search state belongs to the selected project,
              // so repo switches should reset it before the next paint.
              key={draft.projectId}
              repoId={draft.projectId}
              repoMap={repoMap}
              worktrees={worktrees}
              value={draft.baseBranch}
              triggerClassName={`min-w-0 ${pickerTriggerClassName}`}
              onValueChange={(baseBranch) =>
                onDraftChange((current) => ({ ...current, baseBranch }))
              }
            />
          )}
        </div>
      )}
    </Field>
  )
}
