/**
 * zustand middleware that samples store writes during a suspected React commit
 * cascade, so the crash report names the code driving it.
 *
 * Why middleware and not a setState patch: create() hands slices the `set`
 * closure built before `api` exists (zustand/esm/vanilla.mjs), so patching
 * useAppStore.setState afterwards misses every slice-internal set() — and the
 * slices are where the writes are. Wrapping the creator catches both, the same
 * way store-listener-census has to reach the inner api to see hook subscribers.
 *
 * Cost when no cascade is suspected: one boolean field load per write.
 */
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
            // This is the app's universal write path: a diagnostic that throws here
            // would drop the write itself.
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
