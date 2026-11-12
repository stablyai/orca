// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  GITHUB_IDENTITY_PENDING_MAX_MS,
  GITHUB_IDENTITY_POLL_MS,
  gitHubIdentityReducer,
  initialGitHubIdentityState
} from './github-identity-model'
import { useGitHubIdentity } from './use-github-identity'

const getGitHubUser = vi.fn()
const connectGitHubUser = vi.fn()
const disconnectGitHubUser = vi.fn()

const NOT_CONNECTED = { ok: true, value: { connected: false } }
const CONNECTED = { ok: true, value: { connected: true, login: 'octocat', githubUserId: 583231 } }

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'window',
    Object.assign(window, {
      api: { orcaCloudWorkspace: { getGitHubUser, connectGitHubUser, disconnectGitHubUser } }
    })
  )
  getGitHubUser.mockResolvedValue(NOT_CONNECTED)
  connectGitHubUser.mockResolvedValue({ ok: true, value: null })
  disconnectGitHubUser.mockResolvedValue({ ok: true, value: { connected: false } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

/** Lets pending IPC promises settle without running the poll timers. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function mount(confirm = vi.fn(async () => true)) {
  const hook = renderHook(() => useGitHubIdentity(confirm))
  await settle()
  return { hook, confirm }
}

it('stays hidden until the first status read answers, and after a failed read', async () => {
  getGitHubUser.mockResolvedValueOnce({ ok: false, code: 'unavailable', message: 'offline' })
  const { hook } = await mount()
  expect(hook.result.current.state).toEqual({ kind: 'unknown' })
  expect(gitHubIdentityReducer(initialGitHubIdentityState, { type: 'cancel' })).toEqual({
    kind: 'unknown'
  })
})

it('goes not connected → pending → connected when the window regains focus', async () => {
  const { hook } = await mount()
  expect(hook.result.current.state).toEqual({ kind: 'disconnected' })

  await act(() => hook.result.current.connect())
  expect(connectGitHubUser).toHaveBeenCalledOnce()
  expect(hook.result.current.state).toEqual({ kind: 'pending' })

  // Still in the browser: a not-connected answer keeps the row pending.
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(hook.result.current.state).toEqual({ kind: 'pending' })

  getGitHubUser.mockResolvedValue(CONNECTED)
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(hook.result.current.state).toEqual({
    kind: 'connected',
    login: 'octocat',
    githubUserId: 583231
  })
})

it('polls every few seconds while pending, and stops once connected', async () => {
  const { hook } = await mount()
  await act(() => hook.result.current.connect())
  const reads = getGitHubUser.mock.calls.length

  await act(() => vi.advanceTimersByTimeAsync(GITHUB_IDENTITY_POLL_MS))
  expect(getGitHubUser).toHaveBeenCalledTimes(reads + 1)

  getGitHubUser.mockResolvedValue(CONNECTED)
  await act(() => vi.advanceTimersByTimeAsync(GITHUB_IDENTITY_POLL_MS))
  expect(hook.result.current.state.kind).toBe('connected')

  await act(() => vi.advanceTimersByTimeAsync(GITHUB_IDENTITY_POLL_MS * 5))
  expect(getGitHubUser).toHaveBeenCalledTimes(reads + 2)
})

it('Cancel returns to not connected and stops polling', async () => {
  const { hook } = await mount()
  await act(() => hook.result.current.connect())
  act(() => hook.result.current.cancel())
  expect(hook.result.current.state).toEqual({ kind: 'disconnected' })
  const reads = getGitHubUser.mock.calls.length
  await act(() => vi.advanceTimersByTimeAsync(GITHUB_IDENTITY_POLL_MS * 3))
  expect(getGitHubUser).toHaveBeenCalledTimes(reads)
})

it('shows the error when Connect fails or the browser never finishes, and Try again re-opens it', async () => {
  connectGitHubUser.mockResolvedValueOnce({ ok: false, code: 'failed', message: 'nope' })
  const { hook } = await mount()
  await act(() => hook.result.current.connect())
  expect(hook.result.current.state).toEqual({ kind: 'error' })

  // A later "not connected" read keeps the error the person hasn't acted on.
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(hook.result.current.state).toEqual({ kind: 'error' })

  await act(() => hook.result.current.connect())
  expect(hook.result.current.state).toEqual({ kind: 'pending' })
  await act(() => vi.advanceTimersByTimeAsync(GITHUB_IDENTITY_PENDING_MAX_MS))
  expect(hook.result.current.state).toEqual({ kind: 'error' })
})

it('disconnects only after the confirm, then shows not connected', async () => {
  getGitHubUser.mockResolvedValue(CONNECTED)
  const confirm = vi.fn(async () => false)
  const { hook } = await mount(confirm)
  expect(hook.result.current.state.kind).toBe('connected')

  await act(() => hook.result.current.disconnect())
  expect(confirm).toHaveBeenCalledOnce()
  expect(disconnectGitHubUser).not.toHaveBeenCalled()
  expect(hook.result.current.state.kind).toBe('connected')

  confirm.mockResolvedValue(true)
  await act(() => hook.result.current.disconnect())
  expect(disconnectGitHubUser).toHaveBeenCalledOnce()
  expect(hook.result.current.state).toEqual({ kind: 'disconnected' })
})
