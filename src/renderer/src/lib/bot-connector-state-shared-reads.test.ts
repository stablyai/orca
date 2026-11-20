// @vitest-environment happy-dom

import { withBotConnectorRuntime } from './bot-connector-host-calls.test-fixture'
import { act, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBotLinear } from './bot-linear-state'
import { useBotSlack } from './bot-slack-state'

afterEach(() => {
  Reflect.deleteProperty(window, 'api')
})

// Answers after a tick, as an IPC round trip does.
const later = <T>(value: T) =>
  vi.fn(() => new Promise<T>((resolve) => setTimeout(() => resolve(value))))

describe('connector state reads shown on several surfaces at once', () => {
  it('never hands a surface shown after a sign-in the read asked as the account before', async () => {
    const linear = later({ ok: false, error: 'signed_out' })
    const slack = later({ ok: false, error: 'signed_out' })
    Object.assign(window, {
      api: withBotConnectorRuntime({ botLinear: { state: linear }, botSlack: { state: slack } })
    })
    renderHook(() => [useBotLinear('local'), useBotSlack({ hostId: 'local', id: 'bot-2' })])
    useAppStore.setState({
      orcaProfileAuthStatus: {
        activeProfileId: 'p',
        configured: true,
        state: 'connected',
        persistence: 'encrypted',
        cloud: { cloudProfileId: 'c', userId: 'ada', email: 'e@x.dev', linkedAt: 1 }
      }
    })
    renderHook(() => [useBotLinear('local'), useBotSlack({ hostId: 'local', id: 'bot-2' })])
    await act(() =>
      vi.waitFor(() => {
        expect(linear).toHaveBeenCalledTimes(2)
        expect(slack).toHaveBeenCalledTimes(2)
      })
    )
  })
})
