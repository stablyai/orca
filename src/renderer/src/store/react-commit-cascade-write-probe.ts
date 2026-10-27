/** Sample suspected commit cascades through creator middleware: late store.setState patches miss slice set closures captured before api exists. Wrap both slice/external writes for crash attribution; idle cost is one boolean read per write. */
import {
  noteReactCommitCascadeStoreWrite,
  reactCommitCascadeWriteProbe
} from '@/lib/react-commit-cascade-store-write-samples'
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
      const wrapped = (...args: StoreSetArgs<TState>): void => {
        if (reactCommitCascadeWriteProbe.armed) {
          try {
            noteReactCommitCascadeStoreWrite(wrapped, args[0])
          } catch {
            // Never throw from diagnostics on the universal write path or the app write is lost.
          }
        }
        if (args[1] === true) {
          write(...args)
        } else {
          write(...args)
        }
      }
      return wrapped
    }
    // Why separately: an outer middleware may hand slices a different `set` than api.setState.
    api.setState = probe(api.setState)
    return createState(probe(set), get, api)
  }
}
