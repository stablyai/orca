import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'

const indexes = new WeakMap<readonly Tab[], ReadonlyMap<string, Tab>>()

export function indexedWorkerTab(tabs: readonly Tab[] | undefined, id: string): Tab | undefined {
  if (!tabs) {
    return undefined
  }
  let index = indexes.get(tabs)
  if (!index) {
    const next = new Map<string, Tab>()
    for (const tab of tabs) {
      if (!tab.workerTab) {
        continue
      }
      if (!next.has(tab.id)) {
        next.set(tab.id, tab)
      }
      if (!next.has(tab.entityId)) {
        next.set(tab.entityId, tab)
      }
    }
    index = next
    indexes.set(tabs, index)
  }
  return index.get(id)
}
