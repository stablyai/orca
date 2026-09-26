import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { worktreeIdsEqual } from '../../../shared/worktree/id'

export type StructuredActivationInventory = {
  snapshot: RuntimeMobileSessionTabsResult
  ownerBySessionId: ReadonlyMap<string, { owner: 'native' }>
}

export async function readWorktreeStructuredActivationInventory(
  worktreeId: string
): Promise<false | StructuredActivationInventory> {
  if (typeof window === 'undefined') {
    return false
  }
  const response = await window.api.runtime.call({
    method: 'session.tabs.list',
    params: { worktree: toRuntimeWorktreeSelector(worktreeId) }
  })
  if (!response.ok) {
    throw new Error('structured session inventory unavailable')
  }
  const snapshot = response.result as RuntimeMobileSessionTabsResult
  if (
    !snapshot ||
    typeof snapshot.worktree !== 'string' ||
    !worktreeIdsEqual(snapshot.worktree, worktreeId) ||
    !Array.isArray(snapshot.tabs)
  ) {
    throw new Error('structured session inventory scope unavailable')
  }
  if (!snapshot.tabs.some((tab) => tab.type === 'agent-session')) {
    return false
  }
  const ownerBySessionId = new Map<string, { owner: 'native' }>()
  await Promise.all(
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session'
        ? [
            window.api.runtime
              .call({ method: 'agentSession.handoffStatus', params: { sessionId: tab.sessionId } })
              .then((statusResponse) => {
                if (!statusResponse.ok) {
                  return
                }
                const status: unknown = statusResponse.result
                if (
                  typeof status === 'object' &&
                  status !== null &&
                  'owner' in status &&
                  status.owner === 'native'
                ) {
                  ownerBySessionId.set(tab.sessionId, { owner: 'native' })
                }
              })
          ]
        : []
    )
  )
  return { snapshot, ownerBySessionId }
}
