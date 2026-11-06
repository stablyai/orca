import type { CommitMessageAiModelCapability } from '../generation/commit-message-ai-types'
import type { TextGenerationAgentId } from '../../../on-device-text-generation'
import type { TuiAgent } from '../../../agent-launch/catalog/tui-agent'
import type { CustomAgentId } from '../generation/commit-message-agent-spec'
import type {
  SourceControlAiActionDefaults,
  SourceControlActionLaunchPreferences,
  SourceControlActionSurface,
  SourceControlActionRecipe,
  SourceControlActionId,
  SourceControlTextActionId,
  AiTextActionId
} from '../recipes/source-control-ai-actions'

export type AiTextOperation = AiTextActionId
export type SourceControlAiOperation = SourceControlTextActionId

export type SourceControlAiModelChoice = {
  selectedModelByAgent?: Partial<Record<TextGenerationAgentId, string>>
  selectedModelByAgentByHost?: Partial<
    Record<string, Partial<Record<TextGenerationAgentId, string>>>
  >
  selectedThinkingByModel?: Record<string, string>
}

export type SourceControlAiPrCreationDefaults = {
  draft?: boolean
  useTemplate?: boolean
  generateDetailsOnOpen?: boolean
  openAfterCreate?: boolean
}

export type SourceControlAiSettings = {
  enabled: boolean
  actions?: SourceControlAiActionDefaults
  agentId: TextGenerationAgentId | CustomAgentId | null
  selectedModelByAgent: Partial<Record<TextGenerationAgentId, string>>
  selectedModelByAgentByHost?: Partial<
    Record<string, Partial<Record<TextGenerationAgentId, string>>>
  >
  discoveredModelsByAgent?: Partial<Record<TextGenerationAgentId, CommitMessageAiModelCapability[]>>
  discoveredModelsByAgentByHost?: Partial<
    Record<string, Partial<Record<TextGenerationAgentId, CommitMessageAiModelCapability[]>>>
  >
  selectedThinkingByModel: Record<string, string>
  customAgentCommand: string
  instructionsByOperation: Partial<Record<AiTextOperation, string>>
  modelOverridesByOperation?: Partial<Record<AiTextOperation, SourceControlAiModelChoice>>
  prCreationDefaults?: SourceControlAiPrCreationDefaults
  /** @deprecated use actions instead. Kept for automatic migration and rollback compatibility. */
  launchActionDefaults?: SourceControlAiActionDefaults
}

export type SourceControlAiSettingsPatch =
  | Partial<SourceControlAiSettings>
  | ((current: SourceControlAiSettings) => Partial<SourceControlAiSettings>)

export type RepoSourceControlAiOverrides = {
  enabled?: boolean
  customAgentCommand?: string
  modelOverridesByOperation?: Partial<Record<SourceControlAiOperation, SourceControlAiModelChoice>>
  instructionsByOperation?: Partial<Record<SourceControlAiOperation, string | null>>
  actionOverrides?: Partial<
    Record<
      SourceControlActionId,
      {
        // Per-action overrides launch agent CLIs, so they exclude providers with no launch path.
        agentId?: TuiAgent | CustomAgentId | null
        commandInputTemplate?: string | null
        agentArgs?: string | null
        argumentChoices?: SourceControlActionRecipe['argumentChoices']
        launchPreferences?: SourceControlActionLaunchPreferences
        surface?: SourceControlActionSurface
      }
    >
  >
  prCreationDefaults?: {
    draft?: boolean | null
    useTemplate?: boolean | null
    generateDetailsOnOpen?: boolean | null
    openAfterCreate?: boolean | null
  }
}

export type CompleteSourceControlActionRecipe = {
  // Per-action recipes launch agent CLIs, so they exclude providers with no launch path.
  agentId: TuiAgent | CustomAgentId | null
  commandInputTemplate: string
  agentArgs?: string | null
  argumentChoices?: SourceControlActionRecipe['argumentChoices']
  launchPreferences?: SourceControlActionLaunchPreferences
  surface?: SourceControlActionSurface
}

export type WritableRepoSourceControlAiOverrides = {
  enabled?: boolean
  customAgentCommand?: string
  modelOverridesByOperation?: Partial<Record<SourceControlAiOperation, SourceControlAiModelChoice>>
  instructionsByOperation?: Partial<Record<SourceControlAiOperation, string>>
  actionOverrides?: RepoSourceControlAiOverrides['actionOverrides']
  prCreationDefaults?: SourceControlAiPrCreationDefaults
}
