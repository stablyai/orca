import type { AgentType } from '../../agent-status-types'

export type SessionOptionValue = string | boolean

export type SessionOptionSelectChoice = {
  value: string
  label: string
  description?: string
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
  /** A reset action, separate from catalog model IDs. Absent on older hosts and PTY surfaces. */
  defaultChoice?: { selected: boolean; model?: SessionOptionSelectChoice }
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
    }
  | { type: 'clear-model-if-missing'; agent: AgentType; availableModelIds: readonly string[] }
  | { type: 'clear-model'; agent: AgentType }

export type SessionOptionsSurface = {
  resetOption?: (id: string) => Promise<SessionOptionSetResult>
  demandModelCatalog?: () => void
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
