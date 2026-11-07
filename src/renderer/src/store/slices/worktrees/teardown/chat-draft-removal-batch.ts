import type { AppState } from '../../../types'

export function conversationHosts(state: Pick<AppState, 'unifiedTabsByWorktree'>) {
  const hosts = new Map<string, Set<string>>()
  for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
    for (const tab of tabs ?? []) {
      if (tab.contentType === 'agent-session' && tab.executionHostId) {
        const held = hosts.get(tab.entityId) ?? new Set()
        held.add(tab.executionHostId)
        hosts.set(tab.entityId, held)
      }
    }
  }
  return hosts
}

export async function boundedDraftWork<T>(items: readonly T[], work: (item: T) => Promise<void>) {
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++]
        await work(item)
      }
    })
  )
}
