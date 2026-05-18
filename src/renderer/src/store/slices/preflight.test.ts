import { describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { PreflightStatus } from '../../../../preload/api-types'
import type { AppState } from '../types'
import { createPreflightSlice } from './preflight'

const preflightCheck = vi.fn()

globalThis.window = {
  api: {
    preflight: {
      check: preflightCheck,
      detectAgents: vi.fn().mockResolvedValue([]),
      refreshAgents: vi.fn().mockResolvedValue({
        agents: [],
        addedPathSegments: [],
        shellHydrationOk: false,
        pathSource: 'sync_seed_only',
        pathFailureReason: 'spawn_error'
      }),
      detectRemoteAgents: vi.fn().mockResolvedValue([])
    }
  } as unknown as Window['api']
} as Window & typeof globalThis

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createPreflightSlice(...a)
      }) as AppState
  )
}

function makeStatus(glabInstalled: boolean): PreflightStatus {
  return {
    git: { installed: true },
    gh: { installed: true, authenticated: true },
    glab: { installed: glabInstalled, authenticated: glabInstalled }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createPreflightSlice', () => {
  it('dedupes concurrent non-forced checks', async () => {
    preflightCheck.mockReset()
    const pending = deferred<PreflightStatus>()
    preflightCheck.mockReturnValueOnce(pending.promise)
    const store = createTestStore()

    const first = store.getState().refreshPreflightStatus()
    const second = store.getState().refreshPreflightStatus()

    expect(preflightCheck).toHaveBeenCalledTimes(1)
    pending.resolve(makeStatus(true))
    await Promise.all([first, second])

    expect(store.getState().preflightStatus?.glab?.installed).toBe(true)
    expect(store.getState().preflightStatusChecked).toBe(true)
    expect(store.getState().preflightStatusLoading).toBe(false)
  })

  it('lets forced checks bypass non-forced dedupe and win stale races', async () => {
    preflightCheck.mockReset()
    const stale = deferred<PreflightStatus>()
    const fresh = deferred<PreflightStatus>()
    preflightCheck.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const store = createTestStore()

    const normal = store.getState().refreshPreflightStatus()
    const forced = store.getState().refreshPreflightStatus({ force: true })

    expect(preflightCheck).toHaveBeenNthCalledWith(1, undefined)
    expect(preflightCheck).toHaveBeenNthCalledWith(2, { force: true })

    fresh.resolve(makeStatus(true))
    await forced
    stale.resolve(makeStatus(false))
    await normal

    expect(store.getState().preflightStatus?.glab?.installed).toBe(true)
  })

  it('dedupes lazy checks onto an in-flight forced refresh', async () => {
    preflightCheck.mockReset()
    const fresh = deferred<PreflightStatus>()
    preflightCheck.mockReturnValueOnce(fresh.promise)
    const store = createTestStore()

    const forced = store.getState().refreshPreflightStatus({ force: true })
    const lazy = store.getState().refreshPreflightStatus()

    expect(preflightCheck).toHaveBeenCalledTimes(1)
    fresh.resolve(makeStatus(true))
    await Promise.all([forced, lazy])

    expect(store.getState().preflightStatus?.glab?.installed).toBe(true)
  })
})
