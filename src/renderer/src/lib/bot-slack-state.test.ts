// @vitest-environment happy-dom

import { withBotConnectorRuntime } from './bot-connector-host-calls.test-fixture'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BotSlackResult,
  ConnectorBotSlackState
} from '../../../shared/connector-bot-slack-contract'
import { readBotSlack, refreshBotSlack, useBotSlack } from './bot-slack-state'

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'api')
})

describe('refreshBotSlack', () => {
  it('keeps the newest answer when an older read lands last', async () => {
    let answerOlder: (value: BotSlackResult<ConnectorBotSlackState>) => void = () => {}
    const state = vi
      .fn()
      .mockReturnValueOnce(new Promise((resolve) => (answerOlder = resolve)))
      .mockResolvedValueOnce({ ok: true, value: { state: 'not_created' } })
    Object.assign(window, { api: withBotConnectorRuntime({ botSlack: { state } }) })

    const older = refreshBotSlack({ hostId: 'local', id: 'bot-1' })
    await refreshBotSlack({ hostId: 'local', id: 'bot-1' })
    answerOlder({
      ok: true,
      value: {
        state: 'installed',
        teamId: 'T1',
        appId: 'A1',
        botUserId: 'U1',
        installerUserId: 'U2'
      }
    })
    await older
    expect(readBotSlack({ hostId: 'local', id: 'bot-1' })).toEqual({
      status: 'ready',
      slack: { state: 'not_created' }
    })
  })
})

describe('useBotSlack', () => {
  it('follows a pending install with one poll however many surfaces show it', async () => {
    vi.useFakeTimers()
    const state = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { state: 'created', teamId: 'T1', appId: 'A1' } })
    Object.assign(window, { api: withBotConnectorRuntime({ botSlack: { state } }) })

    const panel = renderHook(() => useBotSlack({ hostId: 'local', id: 'bot-2' }))
    const picker = renderHook(() => useBotSlack({ hostId: 'local', id: 'bot-2' }))
    await act(() => vi.advanceTimersByTimeAsync(0))
    const mountReads = state.mock.calls.length

    await act(() => vi.advanceTimersByTimeAsync(3_000))
    expect(state.mock.calls.length).toBe(mountReads + 1)

    panel.unmount()
    picker.unmount()
    await act(() => vi.advanceTimersByTimeAsync(9_000))
    expect(state.mock.calls.length).toBe(mountReads + 1)
  })

  it('reads an app that needs an update only when shown, until the owner starts the update', async () => {
    vi.useFakeTimers()
    const state = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        state: 'installed',
        teamId: 'T1',
        appId: 'A1',
        botUserId: 'U1',
        installerUserId: 'U2',
        updateNeeded: true
      }
    })
    Object.assign(window, { api: withBotConnectorRuntime({ botSlack: { state } }) })

    const shown = renderHook(
      ({ awaitInstall }) => useBotSlack({ hostId: 'local', id: 'bot-3' }, awaitInstall),
      {
        initialProps: { awaitInstall: false }
      }
    )
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(state).toHaveBeenCalledTimes(1)

    shown.rerender({ awaitInstall: true })
    await act(() => vi.advanceTimersByTimeAsync(9_000))
    expect(state).toHaveBeenCalledTimes(4)
    shown.unmount()
  })

  it('stops following a pending install after ten minutes', async () => {
    vi.useFakeTimers()
    const state = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { state: 'created', teamId: 'T1', appId: 'A1' } })
    Object.assign(window, { api: withBotConnectorRuntime({ botSlack: { state } }) })

    const shown = renderHook(() => useBotSlack({ hostId: 'local', id: 'bot-4' }))
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
    const reads = state.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(state.mock.calls.length).toBe(reads)
    shown.unmount()
  })

  it('keeps the last answer through a failed re-read on return, until a click asks again', async () => {
    vi.useFakeTimers()
    const installed = {
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'U1',
      installerUserId: 'U2',
      updateNeeded: true
    }
    const state = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: installed })
      .mockResolvedValue({ ok: false, error: 'cloud_error' })
    Object.assign(window, { api: withBotConnectorRuntime({ botSlack: { state } }) })
    const bot = { hostId: 'local', id: 'bot-5' } as const

    const shown = renderHook(() => useBotSlack(bot))
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    window.dispatchEvent(new Event('focus'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(state).toHaveBeenCalledTimes(2)
    expect(shown.result.current).toEqual({ status: 'ready', slack: installed })

    await act(() => refreshBotSlack(bot))
    expect(shown.result.current).toEqual({ status: 'failed', error: 'cloud_error' })
    shown.unmount()
  })
})
