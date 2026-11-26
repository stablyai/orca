import type { StateCreator } from 'zustand'
import type { RemoteBrowserPageHandle } from '../browser-slice-contract'
import { commitBrowserPageHandleOwnership } from './browser-initialization-presentation-ownership'

type BrowserHandleState = {
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>
}
type WriteContext = { parent?: WriteContext; nestedIds?: Set<string> }

/** Count installed presentations only after every inner write policy accepts the patch. */
export function withBrowserInitializationPresentations<T extends BrowserHandleState>(
  createState: StateCreator<T, [], []>,
  checkInvariant = import.meta.env.DEV
): StateCreator<T, [], []> {
  return (set, get, api) => {
    let active: WriteContext | undefined
    const wrap = (write: typeof set): typeof set => {
      const wrapped = (
        partial: T | Partial<T> | ((state: T) => T | Partial<T>),
        replace?: boolean
      ): void => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preserves both Zustand overloads and the caller's replacement semantics.
        ;(write as (next: (state: T) => T | Partial<T>, replace?: boolean) => void)((state) => {
          const context: WriteContext = { parent: active }
          active = context
          let accepted: ReadonlySet<string> | undefined
          try {
            const patch = typeof partial === 'function' ? partial(state) : partial
            const current = get()
            const handles = Object.hasOwn(patch, 'remoteBrowserPageHandlesByPageId')
              ? patch.remoteBrowserPageHandlesByPageId!
              : current.remoteBrowserPageHandlesByPageId
            accepted = commitBrowserPageHandleOwnership(
              current.remoteBrowserPageHandlesByPageId,
              handles,
              checkInvariant,
              context.nestedIds
            )
            return patch
          } finally {
            active = context.parent
            const ids = accepted ?? context.nestedIds
            if (active && ids?.size) {
              const inherited = (active.nestedIds ??= new Set())
              for (const id of ids) {
                inherited.add(id)
              }
            }
          }
        }, replace)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same implementation forwards full replacement and partial merge writes.
      return wrapped as typeof set
    }
    api.setState = wrap(api.setState)
    return createState(wrap(set), get, api)
  }
}
