import type { AgentType } from './agent-status-types'

export type SessionOptionValue = string | boolean

export type SessionOptionSelectChoice = {
  value: string
  label: string
  description?: string
}

/** `default` is the catalog's own value shown before anything is observed —
 *  truthful to display, but never evidence about a running agent. `dispatched`
 *  is sent-but-unread: the pill shows it, and a later report that disagrees is
 *  what corrects it. Both transports emit it, so it alone names neither — see
 *  `transport` on the descriptor. */
export type SessionOptionValueSource = 'applied' | 'dispatched' | 'reported' | 'default' | 'unknown'

/** How a live value reaches the agent. `catalog` types the catalog's command into
 *  the agent's terminal and can only learn the outcome by parsing the screen back;
 *  `agent-session` writes over the structured protocol, which reports every turn. */
export type NativeChatLiveOptionTransport = 'catalog' | 'agent-session'

/** Closed set of reasons an option is not settable in the current mode. A key
 *  (not free English) so the producer and the localized label stay in sync —
 *  an exhaustive switch turns any drift into a type error instead of leaking
 *  untranslated text. */
export type SessionOptionDisabledReason =
  | 'available-after-session-start'
  | 'set-when-session-starts'

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
    /** Required, unlike the select's: a switch has no third position, so a value
     *  the producer left unset would render as `false` and assert the opposite of
     *  the catalog default. Whether anything confirmed it is `valueSource`'s job. */
    | {
        type: 'boolean'
        currentValue: boolean
      }
  valueSource: SessionOptionValueSource
  /** Required so a new producer cannot inherit the wrong lane's rendering by
   *  omission — `dispatched` is emitted identically by both and cannot discriminate. */
  transport: NativeChatLiveOptionTransport
  settable: boolean
  disabledReason?: SessionOptionDisabledReason
  /** Why: picker-only and toggle-only PTY commands cannot be represented as
   * a truthful radio/checkbox state, so the producer exposes an action row. */
  action?: { type: 'agent-picker' | 'toggle-command' }
}

/** A value we typed at the agent and have never read back. Both lanes write
 *  `dispatched` on a set, so the source alone does not name one — the transport
 *  check is what limits the caption to the terminal, where reading the screen
 *  back is the only confirmation available. */
export function sessionOptionDispatchUnconfirmed(
  descriptor: Pick<SessionOptionDescriptor, 'valueSource' | 'transport'>
): boolean {
  return descriptor.valueSource === 'dispatched' && descriptor.transport === 'catalog'
}

/** Why a boolean row needs a marker at all: the switch always renders a value, so
 *  the row is the only place that can say where the value came from. `default` and
 *  `unreported` are opposite claims — the first says the catalog value is what a
 *  launch will send, the second says nothing has told us anything and the agent may
 *  be running something else entirely — so they never share one label. */
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

export type SessionOptionsSurface = {
  getSnapshot(): SessionOptionDescriptor[]
  /** Apply an absolute target; known flip-only options use their tracked baseline. */
  setOption(id: string, value: SessionOptionValue): Promise<SessionOptionSetResult>
  /** Invoke the value-less action exposed by the current descriptor. */
  invokeAction(id: string): Promise<SessionOptionSetResult>
  subscribe(listener: (snapshot: SessionOptionDescriptor[]) => void): () => void
}
