import type { SourceControlAiModelEdits } from '../../../../../../shared/source-control-ai-action-model-edits'
import type { ActionArgumentChoices } from '../../../../../../shared/source-control-action-argument-choices'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice,
  SourceControlAiSettingsPatch,
  SourceControlAiSettings
} from '../../../../../../shared/source-control-ai-types'
import type {
  SourceControlActionRecipe,
  SourceControlActionId,
  SourceControlActionLaunchPreferences
} from '../../../../../../shared/source-control-ai-actions'

export type RepositorySourceControlAiActionRowsProps = {
  repoId: string
  repoAi: RepoSourceControlAiOverrides
  source: SourceControlAiSettings
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
  /** Lets the text pickers save model lists the repository's host reports. */
  writeSourceControlAiSettings?: (patch: SourceControlAiSettingsPatch) => Promise<void>
  onActionTextModelChoice?: (
    actionId: SourceControlActionId,
    choice: SourceControlAiModelChoice | undefined,
    agentArgs: string,
    edits: SourceControlAiModelEdits | undefined
  ) => void
  onActionModeChange: (actionId: SourceControlActionId, mode: string) => void
  onActionAgentChange: (
    actionId: SourceControlActionId,
    value: string,
    choice?: Pick<SourceControlActionRecipe, 'surface'>
  ) => void
  onActionLaunchPreferencesChange: (
    actionId: SourceControlActionId,
    value: SourceControlActionLaunchPreferences | undefined,
    userArgs?: string,
    argumentChoices?: ActionArgumentChoices | null
  ) => void
  onActionTemplateChange: (actionId: SourceControlActionId, value: string) => void
  onActionAgentArgsChange: (
    actionId: SourceControlActionId,
    value: string,
    commit?: boolean
  ) => void
  onAppendVariable: (actionId: SourceControlActionId, variable: string) => void
  /** Per-action saving state for CLI args + command template (matches global recipes). */
  savingActionIds: Partial<Record<SourceControlActionId, boolean>>
  actionDirtyById: Record<SourceControlActionId, boolean>
  onActionDiscard: (actionId: SourceControlActionId) => void
  onActionSave: (actionId: SourceControlActionId) => void
}
