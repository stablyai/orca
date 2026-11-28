import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeStructuredChatTab, makeTabGroup } from '@/store/slices/tabs/tab-group.test-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { closeMobileSessionTabInStore, dropHostClosedSessionTab } from './mobile-session-tab-close'
import { withLocalSessionTabCloseOwner } from './local-session-tab-close-owner'

const WT = 'wt-host-closed-chat'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Main closes the chat on its host before it asks the window to drop the tab; the window's own
// close must not reach the host a second time.
it('closes the chat on the host only for a close the window started itself', async () => {
  const sent: string[] = []
  vi.stubGlobal('window', {
    api: {
      runtime: {
        call: async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
          sent.push(`${method} ${String(params.sessionId ?? params.tabId)}`)
          return { ok: true, result: {} }
        }
      }
    }
  })
  const chat = (id: string) =>
    makeStructuredChatTab({
      id,
      worktreeId: WT,
      entityId: `session-${id}`,
      groupId: 'g',
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  useAppStore.setState({
    unifiedTabsByWorktree: { [WT]: [chat('a'), chat('b')] },
    groupsByWorktree: {
      [WT]: [makeTabGroup({ id: 'g', worktreeId: WT, tabOrder: ['a', 'b'], activeTabId: 'a' })]
    }
  })

  expect(closeMobileSessionTabInStore(useAppStore.getState(), WT, 'a')).toBe(true)
  useAppStore.getState().closeUnifiedTab('b')
  await vi.waitFor(() => expect(sent).toHaveLength(2))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(sent.sort()).toEqual([
    'agentSession.close session-b',
    'session.tabs.close agent-session:session-b'
  ])
})

function seedChatTab(id: string): void {
  useAppStore.setState({
    unifiedTabsByWorktree: {
      [WT]: [
        makeStructuredChatTab({
          id,
          worktreeId: WT,
          entityId: `session-${id}`,
          groupId: 'g',
          executionHostId: LOCAL_EXECUTION_HOST_ID
        })
      ]
    },
    groupsByWorktree: {
      [WT]: [makeTabGroup({ id: 'g', worktreeId: WT, tabOrder: [id], activeTabId: id })]
    }
  })
}

it('leaves a tab this window is already closing to that close when main says to drop it', async () => {
  vi.stubGlobal('window', {
    api: { runtime: { call: async () => ({ ok: true, result: {} }) } }
  })
  seedChatTab('c')
  const closes = vi.spyOn(useAppStore.getState(), 'closeUnifiedTab')
  const answer = await withLocalSessionTabCloseOwner(WT, 'agent-session:session-c', async () =>
    dropHostClosedSessionTab(useAppStore.getState(), WT, 'agent-session:session-c', 'c')
  )
  expect(answer).toBeUndefined()
  expect(closes).not.toHaveBeenCalled()
})

it('answers main even when dropping the tab throws', () => {
  seedChatTab('d')
  const store = {
    ...useAppStore.getState(),
    closeUnifiedTab: () => {
      throw new Error('layout gone')
    }
  }
  expect(dropHostClosedSessionTab(store, WT, 'agent-session:session-d', 'd')).toBe('layout gone')
})
