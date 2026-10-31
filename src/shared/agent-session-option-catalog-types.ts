import type { AgentChoiceCliForm } from './agent-launch-choices'
import type { AgentType } from './agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice,
  SessionOptionValue
} from './native-chat/input/native-chat-session-options'

export type CatalogAgentInteractionDetection = 'claude-model-switch-confirmation'
export type CatalogCommandDelivery = 'type'

export type CatalogMidSessionApply =
  | {
      kind: 'command'
      build: (value: SessionOptionValue) => string
      pickerCommand?: string
      detectAgentInteraction?: CatalogAgentInteractionDetection
    }
  | { kind: 'toggle-command'; command: string }
  | { kind: 'agent-picker'; command: string; delivery?: CatalogCommandDelivery }
  | { kind: 'unsupported' }

export type CatalogOptionApply = {
  cli?: readonly AgentChoiceCliForm[]
  launchArgs?: (value: SessionOptionValue, trailingAgentArgs?: readonly string[]) => string[]
  /** Removes conflicting free-form args, or detects when to omit the pick from launch args and the record. */
  removeAgentArgs?: (tokens: readonly string[]) => string[]
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
        /** The provider's listing states `defaultValue` is what its CLI runs when no value is sent. */
        defaultIsCliDefault?: true
      }
    | { type: 'boolean'; defaultValue: boolean }
  apply: CatalogOptionApply
}

export type CatalogModel = {
  declaredDefaultEffort?: string | null
  id: string
  label: string
  description?: string
  isDefault?: boolean
  /** Tokens the model's context window holds, where the host's listing states it. */
  contextWindowTokens?: number
  /** The listing says the model runs Approve for me; absent is unknown, which offers it nowhere. */
  supportsAutoMode?: boolean
  options: CatalogOption[]
}

export type AgentSessionOptionCatalog = {
  models: CatalogModel[]
  modelApply: CatalogOptionApply
  /** Opts this agent into structured per-worker launch overrides. */
  supportsWorkerLaunchPreferences?: true
  /** Launch-safe options for opaque model ids that are absent from the static catalog. */
  unknownModelOptions?: CatalogOption[]
  composeModelValue?: (modelId: string, values: Record<string, SessionOptionValue>) => string
  /** Discovery may retire seeded IDs that fatally fail launch; it controls membership while the seed retains option menus. */
  discoveredModelsAreAuthoritative?: true
  /** Show isDefault as selected only when it proves the unflagged CLI model; persisting it also requires probe confirmation (adoptModelAsLaunchDefault). Known gap: user -m in agentArgs can override it while the picker still names the default; thread modelApply.removeAgentArgs to the surface to resolve this. */
  defaultModelIsCliDefault?: true
  /** For a host too old to say so itself: its model listing names the model the account is
   *  configured to run, so a new chat may run the listed default. */
  hostListingNamesConfiguredModel?: true
  listModels?: {
    command: string
    parse: (stdout: string) => CatalogModel[]
  }
}

export type AgentSessionOptionCatalogMap = Partial<Record<AgentType, AgentSessionOptionCatalog>>
