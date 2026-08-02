import type { CommitMessageAiModelCapability, TuiAgent } from './types'
import type { CustomAgentId } from './commit-message-agent-spec'
import type {
  SourceControlAiActionDefaults,
  SourceControlActionId,
  SourceControlTextActionId
} from './source-control-ai-actions'

export type SourceControlAiOperation = SourceControlTextActionId

export type SourceControlAiModelChoice = {
  selectedModelByAgent?: Partial<Record<TuiAgent, string>>
  selectedModelByAgentByHost?: Partial<Record<string, Partial<Record<TuiAgent, string>>>>
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
  agentId: TuiAgent | 'custom' | null
  selectedModelByAgent: Partial<Record<TuiAgent, string>>
  selectedModelByAgentByHost?: Partial<Record<string, Partial<Record<TuiAgent, string>>>>
  discoveredModelsByAgent?: Partial<Record<TuiAgent, CommitMessageAiModelCapability[]>>
  discoveredModelsByAgentByHost?: Partial<
    Record<string, Partial<Record<TuiAgent, CommitMessageAiModelCapability[]>>>
  >
  selectedThinkingByModel: Record<string, string>
  customAgentCommand: string
  instructionsByOperation: Partial<Record<SourceControlAiOperation, string>>
  modelOverridesByOperation?: Partial<Record<SourceControlAiOperation, SourceControlAiModelChoice>>
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
        agentId?: TuiAgent | CustomAgentId | null
        commandInputTemplate?: string | null
        agentArgs?: string | null
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
  agentId: TuiAgent | CustomAgentId | null
  commandInputTemplate: string
  agentArgs?: string
}

export type WritableRepoSourceControlAiOverrides = {
  enabled?: boolean
  customAgentCommand?: string
  modelOverridesByOperation?: Partial<Record<SourceControlAiOperation, SourceControlAiModelChoice>>
  instructionsByOperation?: Partial<Record<SourceControlAiOperation, string>>
  actionOverrides?: Partial<Record<SourceControlActionId, CompleteSourceControlActionRecipe>>
  prCreationDefaults?: SourceControlAiPrCreationDefaults
}
