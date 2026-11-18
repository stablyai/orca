import type { SourceControlAiModelEdits } from '../../../../../../shared/source-control/ai/settings/source-control-ai-action-model-edits'
import type { AiActionId } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice,
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import type { ActionRecipeDraftValue } from '../source-control-ai-action-recipe-draft'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

export type TextModelChange = (
  choice: SourceControlAiModelChoice | undefined,
  agentArgs: string,
  edits: SourceControlAiModelEdits | undefined
) => void

export type TextActionPickerProps = {
  actionId: AiActionId
  agent: TuiAgent | 'custom' | null
  source?: SourceControlAiSettings
  repoId?: string
  repoAi?: RepoSourceControlAiOverrides
  draft: ActionRecipeDraftValue
  draftScope?: object
  disabled?: boolean
  defaultAgentLabel?: string
  onAgentChange: (value: string) => void
  onChange?: TextModelChange
  /** Saves model lists the CLI reports; without it the menu shows only saved lists. */
  writeSourceControlAiSettings?: (patch: SourceControlAiSettingsPatch) => Promise<void>
}
