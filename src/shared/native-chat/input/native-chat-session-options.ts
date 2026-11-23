import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import type {
  AgentCliModelRequirement,
  AgentCliUpdateAgent
} from '../../agent-launch/installation/agent-cli-update'

export type SessionOptionValue = string | boolean

export type SessionOptionSelectChoice = {
  value: string
  label: string
  /** Text for a compact segment; `label` stays its accessible name. */
  shortLabel?: string
  description?: string
  /** Folded under More models; a matching search still lists it. */
  legacy?: true
  /** Listed only by a matching search; never set on the current choice. */
  hidden?: true
}

/** default describes catalog display, never running-agent evidence. dispatched is sent but unread and may be corrected by reports.
 * Both transports emit dispatched; inspect descriptor.transport to distinguish lanes. */
export type SessionOptionValueSource = 'applied' | 'dispatched' | 'reported' | 'default' | 'unknown'

/** catalog types PTY commands and confirms by reading the screen; agent-session uses structured per-turn reports. */
export type NativeChatLiveOptionTransport = 'catalog' | 'agent-session'

/** Closed localized reason keys: exhaustive handling catches drift without leaking untranslated English. */
export type SessionOptionDisabledReason =
  | 'available-after-session-start'
  | 'set-when-session-starts'
  | 'host-update-required'

export type SessionOptionDescriptor = {
  id: string
  label: string
  description?: string
  category?: 'model' | 'thought_level' | 'model_config' | 'mode'
  kind:
    | {
        type: 'select'
        currentValue?: string
        choices: SessionOptionSelectChoice[]
        /** Presentation when no value is known; never an input selection. */
        placeholder?: string
        /** What the running agent reports when currentValue delegates to it; presentation only. */
        reportedValue?: string
        /** The agent whose own settings an Own permission choice follows; presentation only. */
        settingsAgent?: string
      }
    /** Switches require values or unset renders false against the catalog default; confirmation remains valueSource’s responsibility. */
    | {
        type: 'boolean'
        currentValue: boolean
      }
  valueSource: SessionOptionValueSource
  /** Explicit lane is required: dispatched cannot distinguish PTY from structured transports. */
  transport: NativeChatLiveOptionTransport
  settable: boolean
  disabledReason?: SessionOptionDisabledReason
  /** Execution label for Default only; never a picker choice or send option. */
  reportedModel?: string
  reportedModelLabel?: string
  /** Active value when a saved selection intentionally waits for a later input. */
  activeValue?: string
  /** A model row that returns to the agent's own default, apart from the listed model ids. */
  defaultChoice?: { selected: boolean; model?: SessionOptionSelectChoice }
  /** Model-pill display only: a provider fallback runs in place of currentValue, which stays the selection. */
  fallbackModel?: string
  /** Picker-only/flip-only PTY commands need action rows rather than invented absolute control states. */
  action?: { type: 'agent-picker' | 'toggle-command' }
}

/** Sent-but-unread PTY value. Both lanes emit dispatched, so transport must restrict the caption to terminal screen-read confirmation. */
export function sessionOptionDispatchUnconfirmed(
  descriptor: Pick<SessionOptionDescriptor, 'valueSource' | 'transport'>
): boolean {
  return descriptor.valueSource === 'dispatched' && descriptor.transport === 'catalog'
}

/** Switches always display values: distinguish launch-sent catalog defaults from unreported running state, which may differ. */
export type SessionOptionValueMarker = 'default' | 'unreported'

/** Display-only: it labels a rendered value and never gates what is sent, which
 *  stays sourced from tracked picks. */
export function sessionOptionValueMarker(
  descriptor: Pick<SessionOptionDescriptor, 'valueSource'>
): SessionOptionValueMarker | null {
  if (descriptor.valueSource === 'default') {
    return 'default'
  }
  return descriptor.valueSource === 'unknown' ? 'unreported' : null
}

/** Like Fast off, the standard tier adds nothing to a summary pill. */
export function isDefaultServiceTier(
  descriptor: Pick<SessionOptionDescriptor, 'id' | 'kind'>
): boolean {
  return (
    descriptor.id === 'serviceTier' &&
    descriptor.kind.type === 'select' &&
    descriptor.kind.currentValue === 'default'
  )
}

export type SessionOptionSetResult = {
  snapshot: SessionOptionDescriptor[]
}

export type PersistedNativeChatSessionOptions = Partial<
  Record<
    string,
    {
      model?: string
      valuesByModel?: Record<string, Record<string, SessionOptionValue>>
    }
  >
>

export type NativeChatSessionOptionSettingsMutation =
  | {
      type: 'apply-picks'
      agent: AgentType
      picks: readonly {
        modelId: string
        optionId: string
        value: SessionOptionValue
        adoptModelAsLaunchDefault?: boolean
      }[]
      /** The chat the picks were made in; picks in a bot's conversation are kept on that bot. */
      sessionId?: string
    }
  | { type: 'clear-model-if-missing'; agent: AgentType; availableModelIds: readonly string[] }
  /** New chats go back to the agent's own model; per-model values stay for a later pick. */
  | { type: 'clear-model'; agent: AgentType }

/** The user's own CLI on the chat's host, too old for models on Orca's list. */
export type SessionOptionsCliUpdate = {
  agent: AgentCliUpdateAgent
  /** Newest first. */
  models: readonly AgentCliModelRequirement[]
  /** False when the user runs the update themselves; the rows then only say why. */
  runnable: boolean
  phase: 'idle' | 'running' | 'failed'
  start: () => void
  /** Opens the failed run's output; its Try again runs `start`. */
  openFailure: () => void
}

export type SessionOptionsSurface = {
  /** Present only where the host can return the option to the agent's default. */
  resetOption?: (id: string) => Promise<SessionOptionSetResult>
  demandModelCatalog?: () => void
  /** Absent for Orca's own CLI copy and a Command override, and while no listed model needs an update. */
  cliUpdate?: SessionOptionsCliUpdate
  /** Live local admission for a structured action, before consuming its composer trigger. */
  admits?: (id: string, value: SessionOptionValue) => boolean
  getSnapshot(): SessionOptionDescriptor[]
  /** Apply an absolute target; known flip-only options use their tracked baseline. */
  setOption(id: string, value: SessionOptionValue): Promise<SessionOptionSetResult>
  /** Invoke the value-less action exposed by the current descriptor. */
  invokeAction(id: string): Promise<SessionOptionSetResult>
  subscribe(listener: (snapshot: SessionOptionDescriptor[]) => void): () => void
}

/** An effort no list confirms, under a model the list lacks: shown as text, not a control. */
export function isReadOnlySessionOptionValue(descriptor: SessionOptionDescriptor): boolean {
  return (
    descriptor.id === 'effort' &&
    descriptor.kind.type === 'select' &&
    !descriptor.settable &&
    !descriptor.action &&
    descriptor.kind.choices.length === 1
  )
}
