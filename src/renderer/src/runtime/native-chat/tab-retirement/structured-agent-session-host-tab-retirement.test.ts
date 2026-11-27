import { expect, it, vi } from 'vitest'

const endpoints = vi.hoisted(() => ({ closeAgent: vi.fn(), closeTab: vi.fn() }))
vi.mock(
  '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry',
  () => ({
    retireStructuredAgentSessionReadOwner: () => {}
  })
)
vi.mock('@/lib/agent-session/options/structured-agent-session-selection-controller', () => ({
  forgetStructuredSessionSelection: () => {}
}))
vi.mock('../requests/structured-agent-session-close', () => ({
  closeStructuredAgentSession: endpoints.closeAgent
}))
vi.mock('../../web-session-tabs-sync/closing/local-session-tab-close-owner', () => ({
  withLocalSessionTabCloseOwner: (_workspace: string, _tab: string, close: () => Promise<void>) =>
    close()
}))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: endpoints.closeTab }))

import {
  retireStructuredAgentSessionTab,
  waitForStructuredAgentSessionTabRetirement
} from './structured-agent-session-host-tab-retirement'

it('allows a saved chat to reopen only after both host cleanup operations settle', async () => {
  const events: string[] = []
  const agentClosed = Promise.withResolvers<void>()
  const tabClosed = Promise.withResolvers<void>()
  endpoints.closeAgent.mockReturnValue(agentClosed.promise.then(() => events.push('agent closed')))
  endpoints.closeTab.mockReturnValue(
    tabClosed.promise.then(() => {
      events.push('tab closed')
      agentClosed.resolve()
    })
  )
  const target = { kind: 'local' } as const
  const retired = retireStructuredAgentSessionTab({
    target,
    worktreeId: 'workspace',
    sessionId: 'saved-chat'
  })
  const reopened = waitForStructuredAgentSessionTabRetirement(
    target,
    'workspace',
    'saved-chat'
  ).then(() => events.push('revealed'))
  tabClosed.resolve()
  await reopened
  expect(events).toEqual(['tab closed', 'agent closed', 'revealed'])
  expect(await retired).toBe(true)
})

it('reports a failed host tab close to a saved chat waiting to reopen', async () => {
  const failure = new Error('Host is unavailable')
  const onError = vi.fn()
  endpoints.closeAgent.mockResolvedValue(undefined)
  endpoints.closeTab.mockRejectedValue(failure)
  const target = { kind: 'local' } as const
  const sessionId = 'saved-chat-with-close-failure'
  const retired = retireStructuredAgentSessionTab({
    target,
    worktreeId: 'workspace',
    sessionId,
    onError
  })

  expect(await waitForStructuredAgentSessionTabRetirement(target, 'workspace', sessionId)).toBe(
    false
  )
  expect(await retired).toBe(false)
  expect(onError).toHaveBeenCalledWith(failure)
})
