// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { findAgentMessageSenderChatTab } from './native-chat-agent-message-sender-label'

const initial = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState({
    activeWorktreeId: 'workspace',
    activeWorkspaceExecutionHostId: 'local'
  })
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
})

it.each([100, 1000])(
  'shares host-qualified tab collision scans for %i distinct senders and repeated cards',
  (n) => {
    const tab = (id: number, host: 'local' | 'runtime:remote') =>
      makeUnifiedTab({
        id: `${host}-${id}`,
        entityId: `session-${id}`,
        worktreeId: 'workspace',
        groupId: 'g',
        contentType: 'agent-session',
        executionHostId: host
      })
    let tabVisits = 0
    const bucket = Array.from({ length: n }, (_, i) => [
      tab(i, 'local'),
      tab(i, 'runtime:remote')
    ]).flat()
    bucket.forEach((value, i) =>
      Object.defineProperty(bucket, i, {
        get() {
          tabVisits++
          return value
        }
      })
    )
    useAppStore.setState({ unifiedTabsByWorktree: { workspace: bucket } })
    const state = useAppStore.getState()
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        expect(findAgentMessageSenderChatTab(state, `session-${i}`, 'local')?.id).toBe(`local-${i}`)
      }
    }
    // Workspace/session index, per-bucket session index, and qualified collision index each walk 2N tabs once.
    expect(tabVisits).toBe(n * 6)
    tabVisits = 0
    useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' })
    for (let i = 0; i < n; i++) {
      expect(
        findAgentMessageSenderChatTab(useAppStore.getState(), `session-${i}`, 'local')?.id
      ).toBe(`local-${i}`)
    }
    expect(tabVisits).toBe(n * 2) // Only the owner-qualified index invalidates.
  }
)
