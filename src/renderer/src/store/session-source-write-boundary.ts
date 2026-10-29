import type { StateCreator, StoreApi } from 'zustand'
import {
  SESSION_SOURCE_FIELDS,
  SESSION_SOURCE_KINDS,
  type SessionSourceDiscovery,
  type SessionSourceField
} from '../lib/session-source-fields'
import {
  unwrapSessionSourceWrite,
  type SessionSourceSet,
  type SessionSourcePartial
} from './session-source-edits'

type SourceFields<S> = { [F in SessionSourceField]?: F extends keyof S ? S[F] : never }

type SourceApi<S> = Omit<S, 'setState'> & {
  setState: S extends StoreApi<infer T> ? SessionSourceSet<T> : never
  getSessionSourceReceipt(): SessionSourceDiscovery | undefined
}

declare module 'zustand/vanilla' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Zustand's mutator registry must merge with the library interface.
  interface StoreMutators<S, A> {
    'orca/session-source': SourceApi<S> & { readonly sessionSourceOptions?: A }
  }
}

export type SessionStateCreator<T, Slice = T> = StateCreator<
  T,
  [['orca/session-source', never]],
  [],
  Slice
>

export { replaceSessionSourceFields } from './session-source-edits'

/** The fixed-field gate is the only compatibility fallback for an unreported write. */
export function withSessionSourceWrites<T extends object>(
  createState: SessionStateCreator<T>,
  development = import.meta.env.DEV,
  reconcile?: (
    api: StoreApi<T>
  ) => (state: T, requested: SessionSourcePartial<T>) => SessionSourcePartial<T>
): StateCreator<T, [], [['orca/session-source', never]]> {
  const initialize: StateCreator<T, [], []> = (set, get, api) => {
    const prepare = reconcile?.(api)
    let currentReceipt: SessionSourceDiscovery | undefined
    Object.assign(api, { getSessionSourceReceipt: () => currentReceipt })
    const wrap = (write: typeof set): typeof set => {
      const wrapped = (
        partial: T | Partial<T> | ((state: T) => T | Partial<T>),
        replace?: boolean
      ): void => {
        const previousReceipt = currentReceipt
        try {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replacement callers supply a complete root; the wrapper retains their flag.
          ;(write as (partial: (state: T) => T | Partial<T>, replace?: boolean) => void)(
            (state) => {
              const requested = typeof partial === 'function' ? partial(state) : partial
              if (requested === undefined) {
                return state
              }
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: raw Zustand ingress is checked by this same fixed-field gate below.
              const admitted = requested as SessionSourcePartial<T>
              const accepted = prepare ? prepare(state, admitted) : admitted
              const { partial: prepared, receipt: suppliedReceipt } =
                unwrapSessionSourceWrite(accepted)
              let receipt = suppliedReceipt
              const changes = new Map(receipt?.changes)
              const unreported: string[] = []
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixed field domain reads only source properties of this store.
              const priorSources = state as SourceFields<T>
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: accepted partials retain the same store field types.
              const nextSources = prepared as SourceFields<T>
              for (const field of SESSION_SOURCE_FIELDS) {
                if (
                  !(replace || Object.hasOwn(prepared, field)) ||
                  (priorSources[field] === nextSources[field] &&
                    Object.hasOwn(state, field) === Object.hasOwn(prepared, field))
                ) {
                  continue
                }
                if (SESSION_SOURCE_KINDS[field] === 'field') {
                  changes.set(field, null)
                } else if (!changes.has(field)) {
                  unreported.push(field)
                  changes.set(field, null)
                }
              }
              if (unreported.length && development) {
                throw new Error(`Unreported session source write: ${unreported.join(', ')}`)
              }
              receipt = {
                ...receipt,
                changes,
                full: Boolean(receipt?.full || unreported.length),
                fullBoundary: unreported.length ? 'fallback' : receipt?.fullBoundary
              }
              currentReceipt = receipt
              const next = { ...prepared }
              return suppliedReceipt && Object.keys(next).length === 0 ? state : next
            },
            replace
          )
        } finally {
          // Synchronous nested writes restore the outer notification's receipt.
          currentReceipt = previousReceipt
        }
      }
      // SAFETY: one implementation forwards both Zustand replacement overloads unchanged.
      return wrapped as typeof set
    }
    api.setState = wrap(api.setState)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the source API and gate are installed above before this initializer receives them.
    const sourceStateCreator = createState as StateCreator<T, [], []>
    return sourceStateCreator(wrap(set), get, api)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: initialize installs the source API before any slice or subscriber can access it.
  return initialize as StateCreator<T, [], [['orca/session-source', never]]>
}
