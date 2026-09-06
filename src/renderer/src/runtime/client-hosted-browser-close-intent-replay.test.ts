import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('./runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, callRuntimeRpc }
})

import {
  replayClientHostedBrowserCloseIntents,
  resetClientHostedBrowserCloseIntentReplayForTests
} from './client-hosted-browser-close-intent-replay'

const NOW = 1_800_000_000_000

describe('replaying client-hosted browser closes on reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClientHostedBrowserCloseIntentReplayForTests()
  })

  it('re-issues the existing browser.tabClose and clears what the runtime settled', async () => {
    callRuntimeRpc.mockResolvedValue({ closed: true })
    const store = storeWith(['remote-a'])

    await replayClientHostedBrowserCloseIntents('env-a', store)

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-a' },
      // No new method and no new field: an old runtime settles this exactly as it settles a live close.
      'browser.tabClose',
      { worktree: 'id:wt-a', page: 'remote-a' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(store.clearClientHostedBrowserCloseIntents).toHaveBeenCalledWith('env-a', ['remote-a'])
  })

  it.each([['browser_tab_not_found'], ['browser_no_tab'], ['selector_not_found']])(
    'clears an intent the runtime answers with %s',
    async (code) => {
      callRuntimeRpc.mockRejectedValue(Object.assign(new Error(code), { code }))
      const store = storeWith(['remote-a'])

      await replayClientHostedBrowserCloseIntents('env-a', store)

      expect(store.clearClientHostedBrowserCloseIntents).toHaveBeenCalledWith('env-a', ['remote-a'])
    }
  )

  it('keeps an intent the runtime could not be asked about', async () => {
    callRuntimeRpc.mockRejectedValue(new Error('runtime_unreachable'))
    const store = storeWith(['remote-a'])

    await replayClientHostedBrowserCloseIntents('env-a', store)

    // "We could not ask" must never read as "it is gone" — the row would come back next restart.
    expect(store.clearClientHostedBrowserCloseIntents).toHaveBeenCalledWith('env-a', [])
  })

  it('clears only the pages that settled when one of several fails', async () => {
    callRuntimeRpc
      .mockRejectedValueOnce(new Error('runtime_unreachable'))
      .mockResolvedValueOnce({ closed: true })
    const store = storeWith(['remote-a', 'remote-b'])

    await replayClientHostedBrowserCloseIntents('env-a', store)

    expect(store.clearClientHostedBrowserCloseIntents).toHaveBeenCalledWith('env-a', ['remote-b'])
  })

  it('does nothing for an environment that is owed nothing', async () => {
    await replayClientHostedBrowserCloseIntents('env-b', storeWith(['remote-a']))

    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('does not run a second replay for an environment while one is in flight', async () => {
    let release = (): void => {}
    callRuntimeRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ closed: true })
        })
    )
    const store = storeWith(['remote-a'])

    const first = replayClientHostedBrowserCloseIntents('env-a', store)
    await replayClientHostedBrowserCloseIntents('env-a', store)
    release()
    await first

    expect(callRuntimeRpc).toHaveBeenCalledOnce()
  })
})

function storeWith(browserPageIds: string[]) {
  return {
    clientHostedBrowserCloseIntentsByEnvironment: {
      'env-a': browserPageIds.map((browserPageId) => ({
        browserPageId,
        worktreeId: 'wt-a',
        closedAt: NOW
      }))
    },
    clearClientHostedBrowserCloseIntents: vi.fn()
  }
}
