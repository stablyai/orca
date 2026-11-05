import type { TextGenerationAgentId } from '../../../on-device-text-generation'

export type CommitMessageAiModelCapability = {
  id: string
  label: string
  thinkingLevels?: { id: string; label: string }[]
  defaultThinkingLevel?: string
}

export type CommitMessageAiSettings = {
  enabled: boolean
  agentId: TextGenerationAgentId | 'custom' | null
  /** Per-agent: switching agents preserves the previously-picked model. */
  selectedModelByAgent: Partial<Record<TextGenerationAgentId, string>>
  /** Host-scoped model selections; dynamic agents can expose different models per SSH target. */
  selectedModelByAgentByHost?: Partial<
    Record<string, Partial<Record<TextGenerationAgentId, string>>>
  >
  /** Per-agent dynamic models last discovered from the CLI, persisted so main can validate selections. */
  discoveredModelsByAgent?: Partial<Record<TextGenerationAgentId, CommitMessageAiModelCapability[]>>
  discoveredModelsByAgentByHost?: Partial<
    Record<string, Partial<Record<TextGenerationAgentId, CommitMessageAiModelCapability[]>>>
  >
  /** Thinking effort is model-specific, keyed by model ID. */
  selectedThinkingByModel: Record<string, string>
  /** Optional user-provided suffix appended to the base prompt (style overrides, etc.). */
  customPrompt: string
  /** Command template for agentId === 'custom'; {prompt} substitutes the diff prompt via argv, else the prompt is piped via stdin. */
  customAgentCommand: string
}
