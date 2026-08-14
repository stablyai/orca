import type { AgentType } from './agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice,
  SessionOptionValue
} from './native-chat-session-options'

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
  launchArgs?: (value: SessionOptionValue) => string[]
  /** Why: later free-form args win, so the launch record must discard any
   * picker value that those args may have replaced. */
  agentArgsOverride?: (tokens: readonly string[]) => boolean
  /** Removes conflicting defaults before a more specific launch choice is inserted. */
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
  /** Opts this agent into structured per-worker launch overrides. */
  supportsWorkerLaunchPreferences?: true
  /** Launch-safe options for opaque model ids that are absent from the static catalog. */
  unknownModelOptions?: CatalogOption[]
  composeModelValue?: (modelId: string, values: Record<string, SessionOptionValue>) => string
  /** Why: a seeded id the CLI has retired is a fatal launch, so a successful probe
   * must be able to drop it rather than only add. Membership only — option menus
   * still come from the seed. */
  discoveredModelsAreAuthoritative?: true
  /** Set only when the `isDefault` model is provably what the CLI runs with no model
   * flag, so an untouched draft may show it as selected. Off means `isDefault` stays
   * decorative: agents whose default comes from account or user config would otherwise
   * present a guess as the launch's model. Adopting this default as a persisted launch
   * flag additionally requires a probe to confirm it — see `adoptModelAsLaunchDefault`.
   *
   * Known gap: "no model flag" is unverified. A user `-m` in `agentArgs` launches that
   * model while the picker, which never reads launch args, still names the CLI default.
   * A real fix means threading `modelApply.agentArgsOverride` through to the surface. */
  defaultModelIsCliDefault?: true
  listModels?: {
    command: string
    parse: (stdout: string) => CatalogModel[]
  }
}

export type AgentSessionOptionCatalogMap = Partial<Record<AgentType, AgentSessionOptionCatalog>>
