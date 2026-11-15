import type { ClaudeApiEndpointSummary } from './managed-account-types'

export type ClaudeApiEndpointPreset = ClaudeApiEndpointSummary & {
  id: string
  label: string
  /** Other models the provider serves, offered next to `model`. */
  otherModels: string[]
}

// Sakana AI serves the Anthropic Messages API at /v1/messages; fugu-ultra is slower but stronger.
export const CLAUDE_API_ENDPOINT_PRESETS: readonly ClaudeApiEndpointPreset[] = [
  {
    id: 'sakana',
    label: 'Sakana AI',
    baseUrl: 'https://api.sakana.ai',
    model: 'fugu',
    smallFastModel: 'fugu',
    otherModels: ['fugu-ultra']
  }
]
