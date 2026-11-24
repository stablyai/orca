/** A yes/no answer per id that can change, read per id: a reader subscribes and redraws only when
 *  its own answer flips, not whenever the whole answer is replaced. */
export type MembershipStore = {
  has: (id: string) => boolean
  subscribe: (listener: () => void) => () => void
  /** Replaces the answer; readers whose id answers the same are not redrawn by React. */
  set: (has: (id: string) => boolean) => void
}

export function createMembershipStore(initial: (id: string) => boolean): MembershipStore {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    has: (id) => current(id),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (has) => {
      if (has !== current) {
        current = has
        listeners.forEach((notify) => notify())
      }
    }
  }
}
