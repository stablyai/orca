import type { CommitMessageAiModelCapability, TuiAgent } from './types'

export type SourceControlAiOperation = 'commitMessage' | 'pullRequest' | 'branchName'

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
}

export type RepoSourceControlAiOverrides = {
  modelOverridesByOperation?: Partial<Record<SourceControlAiOperation, SourceControlAiModelChoice>>
  instructionsByOperation?: Partial<Record<SourceControlAiOperation, string | null>>
  prCreationDefaults?: {
    draft?: boolean | null
    useTemplate?: boolean | null
    generateDetailsOnOpen?: boolean | null
    openAfterCreate?: boolean | null
  }
}
