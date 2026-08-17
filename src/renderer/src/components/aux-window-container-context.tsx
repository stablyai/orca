import { createContext, useContext } from 'react'

/**
 * The element floating layers should portal into for the current subtree.
 *
 * Radix's Portal defaults to `globalThis.document.body`, which is resolved in
 * the main realm — so a menu or tooltip opened from a pane that lives in a
 * detached window would render into the wrong window. `DetachedTabGroupWindow`
 * provides its own container here, and React context crosses portals, so every
 * descendant picks it up without threading a prop through each call site.
 *
 * `null` means "the main window", which is Radix's own default.
 */
const AuxWindowContainerContext = createContext<HTMLElement | null>(null)

export const AuxWindowContainerProvider = AuxWindowContainerContext.Provider

export function useAuxWindowContainer(): HTMLElement | null {
  return useContext(AuxWindowContainerContext)
}
