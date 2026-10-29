import type {
  SessionSourceDiscovery,
  SessionSourceField,
  SessionSourceKind
} from '../lib/session-source-fields'
import type { SessionSourceWrite } from './session-source-edits'

export type SourceKey<S> = Extract<keyof S, SessionSourceField>
export type RecordKey<S> = Extract<SourceKey<S>, SessionSourceKind<'keyed'>>
export type Entry<S, F extends RecordKey<S>> =
  NonNullable<S[F]> extends ReadonlyMap<string, infer V>
    ? V
    : NonNullable<S[F]> extends Record<string, infer V>
      ? V
      : never
export type OrdinarySourcePartial<S> = Partial<S> &
  Partial<Record<SessionSourceKind<'keyed' | 'sequence'>, never>> & {
    readonly sourceWrite?: never
  }
export type SessionSourcePartial<S> = OrdinarySourcePartial<S> | SessionSourceWrite<S>
export type SessionSourceUpdate<S> =
  | SessionSourcePartial<S>
  | ((state: S) => SessionSourcePartial<S> | undefined)
export type SessionSourceSetArgs<S> =
  | [partial: SessionSourceUpdate<S>, replace?: false]
  | [partial: SessionSourceWrite<S>, replace: true]
export type SessionSourceSet<S> = {
  (partial: SessionSourceUpdate<S>, replace?: false): void
  (partial: SessionSourceWrite<S>, replace: true): void
}

export type SourceWriteData<S> = {
  partial: Readonly<Partial<S>>
  receipt: SessionSourceDiscovery | undefined
}
