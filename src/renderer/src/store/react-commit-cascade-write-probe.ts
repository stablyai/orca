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

export function withReactCommitCascadeWriteProbe<TState>(
  createState: StateCreator<TState, [], []>
): StateCreator<TState, [], []> {
  return (set, get, api) => {
    const wrapped = ((partial: unknown, replace?: unknown): void => {
      if (reactCommitCascadeWriteProbe.armed) {
        try {
          noteReactCommitCascadeStoreWrite(wrapped, partial)
        } catch {
          // This is the app's universal write path: a diagnostic that throws here
          // would drop the write itself.
        }
      }
      ;(set as (nextPartial: unknown, nextReplace?: unknown) => void)(partial, replace)
    }) as typeof set
    api.setState = wrapped as typeof api.setState
    return createState(wrapped, get, api)
  }
}
