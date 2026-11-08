// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatFork } from './use-native-chat-fork'
import { launchNativeChatFork } from './native-chat-fork-launch'

vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
vi.mock('@/runtime/native-chat/agent-catalogs/use-host-structured-agent', () => ({
  useHostStructuredAgent: () => ({ agent: 'opencode', capabilities: { fork: 'tip' } })
}))
const settle = vi.hoisted(() => vi.fn())
vi.mock('./native-chat-side-chat-placement', () => ({
  beginNativeChatSideChatPlacement: () => ({ settle })
}))
vi.mock('./native-chat-fork-launch', () => ({
  launchNativeChatFork: vi.fn(),
  nativeChatForkSurfaceAddress: vi.fn()
}))

function forkFor(sessionForkSupport: 'supported' | 'unsupported' | 'unknown' | undefined) {
  return renderHook(() =>
    useNativeChatFork({
      sessionId: 'opencode_source',
      tabId: 'tab-source',
      agent: 'opencode',
      target: { kind: 'local' },
      worktreeId: 'wt-1',
      items: [],
      epoch: 'epoch-1',
      contextFloor: undefined,
      sessionForkSupport
    })
  ).result.current
}

it.each([
  ['sent', { sessionId: 'side', executionHostId: 'local' }],
  ['unconfirmed', { sessionId: 'side', executionHostId: 'local' }],
  ['failed', undefined]
] as const)('places a side chat whose question was %s: %o', async (question, placed) => {
  vi.mocked(launchNativeChatFork).mockResolvedValue({
    chat: { sessionId: 'side', executionHostId: 'local' },
    question
  })
  settle.mockClear()

  await forkFor('supported')?.request('reply-1', { question: 'why?' })

  expect(settle).toHaveBeenCalledWith(placed)
})
