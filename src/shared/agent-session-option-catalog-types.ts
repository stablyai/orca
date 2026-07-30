import type { AgentType } from './agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice,
  SessionOptionValue
} from './native-chat-session-options'

export type CatalogAgentInteractionDetection = 'claude-model-switch-confirmation'

export type CatalogMidSessionApply =
  | {
      kind: 'command'
      build: (value: SessionOptionValue) => string
      pickerCommand?: string
      detectAgentInteraction?: CatalogAgentInteractionDetection
    }
  | { kind: 'toggle-command'; command: string }
  | { kind: 'agent-picker'; command: string }
  | { kind: 'unsupported' }

export type CatalogOptionApply = {
  launchArgs?: (value: SessionOptionValue) => string[]
  /** Why: later free-form args win, so the launch record must discard any
   * picker value that those args may have replaced. */
  agentArgsOverride?: (tokens: readonly string[]) => boolean
  composedIntoModel?: true
  midSession?: CatalogMidSessionApply
}

export type CatalogOption = {
  id: string
  label: string
  description?: string
  category?: SessionOptionDescriptor['category']
  kind:
    | {
        type: 'select'
        choices: SessionOptionSelectChoice[]
        defaultValue: string
      }
    | { type: 'boolean'; defaultValue: boolean }
  apply: CatalogOptionApply
}

export type CatalogModel = {
  id: string
  label: string
  description?: string
  isDefault?: boolean
  options: CatalogOption[]
}

export type AgentSessionOptionCatalog = {
  models: CatalogModel[]
  modelApply: CatalogOptionApply
  composeModelValue?: (modelId: string, values: Record<string, SessionOptionValue>) => string
  listModels?: {
    command: string
    parse: (stdout: string) => CatalogModel[]
  }
}

export type AgentSessionOptionCatalogMap = Partial<Record<AgentType, AgentSessionOptionCatalog>>
