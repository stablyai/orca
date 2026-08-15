export type SessionOptionValue = string | boolean

/** Closed set of actions offered in place of an unselectable choice. A key (not
 *  free English) so the producer and the localized label stay in sync. */
export type SessionOptionChoiceAction = 'open-agent-permissions-setting'

export type SessionOptionSelectChoice = {
  value: string
  label: string
  description?: string
  /** Not selectable now; the row offers this action instead. */
  unavailable?: { action: SessionOptionChoiceAction }
}

/** `default` is the catalog's own value shown before anything is observed —
 *  truthful to display, but never evidence about a running agent. */
export type SessionOptionValueSource = 'applied' | 'dispatched' | 'reported' | 'default' | 'unknown'

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
    | {
        type: 'boolean'
        currentValue?: boolean
      }
  valueSource: SessionOptionValueSource
  settable: boolean
  disabledReason?: SessionOptionDisabledReason
  /** Why: picker-only and toggle-only PTY commands cannot be represented as
   * a truthful radio/checkbox state, so the producer exposes an action row. */
  action?: { type: 'agent-picker' }
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

export type SessionOptionsSurface = {
  getSnapshot(): SessionOptionDescriptor[]
  /** Apply an absolute target; known flip-only options use their tracked baseline. */
  setOption(id: string, value: SessionOptionValue): Promise<SessionOptionSetResult>
  /** Invoke the value-less action exposed by the current descriptor. */
  invokeAction(id: string): Promise<SessionOptionSetResult>
  subscribe(listener: (snapshot: SessionOptionDescriptor[]) => void): () => void
}
