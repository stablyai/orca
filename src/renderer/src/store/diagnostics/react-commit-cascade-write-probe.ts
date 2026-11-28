/** Sample suspected commit cascades through creator middleware: late store.setState patches miss slice set closures captured before api exists. Wrap both slice/external writes for crash attribution; idle cost is one boolean read per write. */
import {
  noteReactCommitCascadeStoreWrite,
  reactCommitCascadeWriteProbe
} from '@/diagnostics/react-commits/react-commit-cascade-store-write-samples'
import type { StateCreator } from 'zustand'

/** zustand's two `setState` call shapes, as a union so a wrapper can forward them uncast. */
export type StoreSetArgs<TState> =
  | [
      partial: TState | Partial<TState> | ((state: TState) => TState | Partial<TState>),
      replace?: false
    ]
  | [state: TState | ((state: TState) => TState), replace: true]

export function withReactCommitCascadeWriteProbe<TState>(
  createState: StateCreator<TState, [], []>
): StateCreator<TState, [], []> {
  return (set, get, api) => {
    const probe = (write: typeof set): typeof set => {
      const wrapped = (
        partial: TState | Partial<TState> | ((state: TState) => TState | Partial<TState>),
        replace?: boolean
      ): void => {
        if (reactCommitCascadeWriteProbe.armed) {
          try {
            noteReactCommitCascadeStoreWrite(wrapped, partial)
          } catch {
            // Never throw from diagnostics on the universal write path or the app write is lost.
          }
        }
        if (replace === true) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replace=true overload requires a complete TState or updater returning TState.
          write(partial as TState | ((state: TState) => TState), true)
        } else {
          write(partial, false)
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: named parameters implement both Zustand setState overloads without rest-args allocation.
      return wrapped as typeof set
    }
    // Why separately: an outer middleware may hand slices a different `set` than api.setState.
    api.setState = probe(api.setState)
    return createState(probe(set), get, api)
  }
}
