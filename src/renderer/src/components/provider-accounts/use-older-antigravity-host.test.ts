// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

const capability = vi.hoisted(() => ({ state: 'unknown', asked: [] as string[] }))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: (_host: unknown, name: string) => {
    capability.asked.push(name)
    return capability.state
  }
}))

import { useOlderAntigravityHost } from './use-older-antigravity-host'

afterEach(cleanup)

it.each([
  ['unsupported', true],
  ['supported', false],
  ['unknown', false]
])('reads a host whose agy-chats capability is %s as older: %s', (state, older) => {
  capability.state = state
  const { result } = renderHook(() => useOlderAntigravityHost({ kind: 'local' }))
  expect(result.current).toBe(older)
  expect(capability.asked.at(-1)).toBe('accounts.antigravity-agy-chats.v1')
})
