import { describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_CONNECTED_ANSWER_RUNTIME_CAPABILITY,
  GOOGLE_CONNECT_RUNTIME_CAPABILITY,
  GOOGLE_TRIGGERS_RUNTIME_CAPABILITY
} from '../../../../../shared/google/google-connect-types'
import { googleConnectedAnswerIsHidden } from './google-connected-answer'

// What each paired host advertises: `old` is a host from before google.bot.connected.
const hosts: Record<string, readonly string[]> = {
  old: [GOOGLE_CONNECT_RUNTIME_CAPABILITY, GOOGLE_TRIGGERS_RUNTIME_CAPABILITY],
  new: [
    GOOGLE_CONNECT_RUNTIME_CAPABILITY,
    GOOGLE_TRIGGERS_RUNTIME_CAPABILITY,
    GOOGLE_CONNECTED_ANSWER_RUNTIME_CAPABILITY
  ]
}

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async (environmentId: string, capability: string) =>
    hosts[environmentId]?.includes(capability) === true
}))

describe('googleConnectedAnswerIsHidden', () => {
  it('falls back to the typed line only on a host without google.bot.connected', async () => {
    expect(await googleConnectedAnswerIsHidden({ kind: 'local' })).toBe(true)
    expect(await googleConnectedAnswerIsHidden({ kind: 'environment', environmentId: 'new' })).toBe(
      true
    )
    expect(await googleConnectedAnswerIsHidden({ kind: 'environment', environmentId: 'old' })).toBe(
      false
    )
  })
})
