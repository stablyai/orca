import type { CommitMessageAiSettings } from '../source-control/ai/generation/commit-message-ai-types'

export function getDefaultCommitMessageAiSettings(): CommitMessageAiSettings {
  return {
    enabled: true,
    agentId: null,
    selectedModelByAgent: {},
    discoveredModelsByAgent: {},
    selectedModelByAgentByHost: {},
    discoveredModelsByAgentByHost: {},
    selectedThinkingByModel: {},
    customPrompt: '',
    customAgentCommand: ''
  }
}
