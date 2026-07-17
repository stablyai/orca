export type SessionOptionValue = string | boolean

export type SessionOptionSelectChoice = {
  value: string
  label: string
  description?: string
}

export type SessionOptionValueSource = 'applied' | 'dispatched' | 'reported' | 'unknown'

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
    | { type: 'boolean'; currentValue?: boolean }
  valueSource: SessionOptionValueSource
  settable: boolean
  disabledReason?: SessionOptionDisabledReason
  /** Why: picker-only and toggle-only PTY commands cannot be represented as
   * a truthful radio/checkbox state, so the producer exposes an action row. */
  action?: { type: 'agent-picker' | 'toggle-command' }
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
  setOption(id: string, value: SessionOptionValue): Promise<SessionOptionSetResult>
  subscribe(listener: (snapshot: SessionOptionDescriptor[]) => void): () => void
}
