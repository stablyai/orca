import { makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'

/** Count actual unrelated ownership reads through the production store actions, including copies. */
export function instrumentUnrelatedTerminalBindings(size: number, worktreeId: string) {
  const counts = { ownershipVisits: 0, bindingVisits: 0 }
  const tabs = Array.from({ length: size }, (_, i) => {
    const tab = makeTerminalTab({
      id: `unrelated-${i}`,
      worktreeId,
      ptyId: `unrelated-pty-${i}`
    })
    Object.defineProperty(tab, 'id', {
      enumerable: true,
      get: () => {
        counts.ownershipVisits++
        return `unrelated-${i}`
      }
    })
    return tab
  })
  const ptyIdsByTabId = Object.fromEntries(
    tabs.map((tab) => {
      const ptyIds: string[] = []
      Object.defineProperty(ptyIds, 0, {
        enumerable: true,
        get: () => {
          counts.bindingVisits++
          return tab.ptyId!
        }
      })
      return [tab.id, ptyIds]
    })
  )
  return { tabs, ptyIdsByTabId, counts }
}
