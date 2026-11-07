// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatFork } from './use-native-chat-fork'

vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
vi.mock('@/runtime/use-host-structured-agent', () => ({
  useHostStructuredAgent: () => ({ agent: 'opencode', capabilities: { fork: 'tip' } })
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

it('takes the chat options verdict on its installed agent', () => {
  expect(forkFor('unsupported')).toBeUndefined()
  expect(forkFor('unknown')?.support).toEqual({ kind: 'unknown' })
  expect(forkFor(undefined)?.support).toEqual({ kind: 'unknown' })
  expect(forkFor('supported')?.support).toEqual({ kind: 'known', fork: 'tip' })
})
