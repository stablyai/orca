import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

export type StructuredActivationInventory = {
  snapshot: RuntimeMobileSessionTabsResult
  ownerBySessionId: ReadonlyMap<
    string,
    {
      owner: 'native' | 'tui'
      terminal?: { paneKey: string; ptyId: string; tabId: string }
    }
  >
}

export async function readWorktreeStructuredActivationInventory(
  worktreeId: string
): Promise<false | StructuredActivationInventory> {
  if (typeof window === 'undefined') {
    return false
  }
  const response = await window.api.runtime.call({ method: 'session.tabs.listAll', params: {} })
  if (!response.ok) {
    throw new Error('structured session inventory unavailable')
  }
  const result = response.result as { snapshots?: RuntimeMobileSessionTabsResult[] }
  const snapshot = (result.snapshots ?? []).find(
    (candidate) =>
      candidate.worktree === worktreeId &&
      candidate.tabs.some((tab) => tab.type === 'agent-session')
  )
  if (!snapshot) {
    return false
  }
  const ownerBySessionId = new Map<
    string,
    {
      owner: 'native' | 'tui'
      terminal?: { paneKey: string; ptyId: string; tabId: string }
    }
  >()
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
                const status = statusResponse.result as {
                  owner?: unknown
                  terminal?: { paneKey?: unknown; ptyId?: unknown; tabId?: unknown }
                }
                if (status.owner === 'native') {
                  ownerBySessionId.set(tab.sessionId, { owner: 'native' })
                } else if (
                  status.owner === 'tui' &&
                  typeof status.terminal?.paneKey === 'string' &&
                  typeof status.terminal?.ptyId === 'string' &&
                  status.terminal.ptyId.length > 0 &&
                  typeof status.terminal.tabId === 'string'
                ) {
                  ownerBySessionId.set(tab.sessionId, {
                    owner: 'tui',
                    terminal: {
                      paneKey: status.terminal.paneKey,
                      ptyId: status.terminal.ptyId,
                      tabId: status.terminal.tabId
                    }
                  })
                }
              })
          ]
        : []
    )
  )
  return { snapshot, ownerBySessionId }
}
