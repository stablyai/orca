// @vitest-environment happy-dom

import { withBotConnectorRuntime } from './bot-connector-host-calls.test-fixture'
import { act, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshBotGitHub, useBotGitHub } from './bot-github-state'
import { refreshBotLinear, useBotLinear } from './bot-linear-state'
import { useBotSlack } from './bot-slack-state'

afterEach(() => {
  Reflect.deleteProperty(window, 'api')
})

// Answers after a tick, as an IPC round trip does.
const later = <T>(value: T) =>
  vi.fn(() => new Promise<T>((resolve) => setTimeout(() => resolve(value))))

describe('connector state reads shown on several surfaces at once', () => {
  it('ask the cloud once per connector, not once per surface', async () => {
    const github = later({ ok: false, error: 'github_off' })
    const linear = later({ ok: false, error: 'linear_off' })
    const slack = later({ ok: true, value: { state: 'not_created' } })
    Object.assign(window, {
      api: withBotConnectorRuntime({
        botGitHub: { state: github },
        botLinear: { state: linear },
        botSlack: { state: slack }
      })
    })

    // A restored bot view: tab-group headers, cards and settings all mount in one commit.
    const surfaces = [1, 2, 3, 4, 5].map(() =>
      renderHook(() => [
        useBotGitHub('local'),
        useBotLinear('local'),
        useBotSlack({ hostId: 'local', id: 'bot-1' })
      ])
    )
    await act(() =>
      vi.waitFor(() => {
        expect(surfaces[4].result.current[0]).toEqual({ status: 'off' })
        expect(surfaces[4].result.current[1]).toEqual({ status: 'off' })
        expect(surfaces[4].result.current[2]).toMatchObject({ status: 'ready' })
      })
    )
    expect(github).toHaveBeenCalledTimes(1)
    expect(linear).toHaveBeenCalledTimes(1)
    expect(slack).toHaveBeenCalledTimes(1)

    // An explicit refresh, as after a link or an unlink, still asks fresh.
    await act(() => Promise.all([refreshBotGitHub('local'), refreshBotLinear('local')]))
    expect(github).toHaveBeenCalledTimes(2)
    expect(linear).toHaveBeenCalledTimes(2)

    // A surface shown after the answer reads fresh, as before.
    renderHook(() => useBotGitHub('local'))
    await act(() => vi.waitFor(() => expect(github).toHaveBeenCalledTimes(3)))
    surfaces.forEach((surface) => surface.unmount())
  })

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
