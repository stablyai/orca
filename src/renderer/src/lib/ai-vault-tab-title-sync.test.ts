import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSessionTitlesResult } from '../../../shared/ai-vault/contracts/ai-vault-session-title'
import { resolveTerminalTabTitle } from '../../../shared/tab-title-resolution'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { AiVaultTitleRequest } from './ai-vault-tab-title-requests'
import { settleAiVaultTitleRequestBatches } from './ai-vault-tab-title-batches'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'

import { makeState, titleResult } from './ai-vault-tab-title-test-store'

describe('AI Vault tab title sync', () => {
  it('retains a recovered sleeping title after its lifecycle record disappears', async () => {
    const store = makeState({
      executionHostId: 'ssh:dev-box',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore',
      sleeping: true
    })
    const stop = startAiVaultTabTitleSync({
      ...store,
      resolveSessionTitles: async () => titleResult('codex', 'Stable conversation')
    })

    await vi.waitFor(() =>
      expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle).toBeTruthy()
    )
    store.removeSleepingRecord()
    const restored = store.getState().tabsByWorktree['worktree-1'][0] as TerminalTab
    expect(resolveTerminalTabTitle(restored, false)).toBe('Stable conversation')
    stop()
  })

  it('drops a client result that returns after the paired host started naming the tab', async () => {
    const store = makeState({
      executionHostId: 'runtime:server-1',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore'
    })
    let respond: ((result: AiVaultSessionTitlesResult) => void) | undefined
    const resolveSessionTitles = vi.fn(
      () =>
        new Promise<AiVaultSessionTitlesResult>((resolve) => {
          respond = resolve
        })
    )
    const stop = startAiVaultTabTitleSync({ ...store, resolveSessionTitles })

    await vi.waitFor(() => expect(respond).toBeTypeOf('function'))
    store.nameFromHost('Host name')
    respond?.(titleResult('codex', 'Client name'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe('Host name')
    expect(resolveSessionTitles).toHaveBeenCalledTimes(1)
    stop()
  })

  it('defers title reads through the configured background scheduler', async () => {
    const store = makeState({
      executionHostId: 'ssh:dev-box',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore'
    })
    const resolveSessionTitles = vi.fn(async () => titleResult('codex', 'Deferred conversation'))
    let runScheduled: (() => void) | undefined
    const cancelScheduled = vi.fn()
    const stop = startAiVaultTabTitleSync({
      ...store,
      resolveSessionTitles,
      scheduleReconcile: (callback) => {
        runScheduled = callback
        return cancelScheduled
      }
    })

    expect(resolveSessionTitles).not.toHaveBeenCalled()
    runScheduled?.()
    await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalledTimes(1))
    stop()
  })

  it('does not reread when a live status ping preserves title inputs', async () => {
    const store = makeState({
      executionHostId: 'ssh:dev-box',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore'
    })
    const resolveSessionTitles = vi.fn(async () => titleResult('codex', 'Stable conversation'))
    const stop = startAiVaultTabTitleSync({ ...store, resolveSessionTitles })

    await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalledTimes(1))
    store.pingAgentStatus()
    await Promise.resolve()
    await Promise.resolve()

    expect(resolveSessionTitles).toHaveBeenCalledTimes(1)
    stop()
  })

  it('reconciles immediately when the provider session identity changes', async () => {
    const store = makeState({
      executionHostId: 'ssh:dev-box',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore'
    })
    const resolveSessionTitles = vi.fn(async () => titleResult('codex', 'Original conversation'))
    const stop = startAiVaultTabTitleSync({ ...store, resolveSessionTitles })

    await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalledTimes(1))
    store.setProviderSessionId('codex-session-2')

    await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalledTimes(2))
    expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle).toBeNull()
    stop()
  })

  it('runs hosts concurrently while serializing each host wire', async () => {
    const request = (executionHostId: AiVaultTitleRequest['executionHostId'], index: number) => ({
      agent: 'codex' as const,
      executionHostId,
      providerSession: { key: 'session_id' as const, id: `session-${index}` },
      refresh: true,
      tabId: `tab-${index}`,
      paneKey: `tab-${index}:leaf-1`,
      worktreeId: `worktree-${index}`
    })
    const requests = [
      ...Array.from({ length: 65 }, (_, index) => request('ssh:dev-box', index)),
      request('runtime:server-1', 100)
    ]
    const calls: AiVaultTitleRequest[][] = []
    const completions: (() => void)[] = []
    const pending = settleAiVaultTitleRequestBatches(
      requests,
      (batch) =>
        new Promise<void>((resolve) => {
          calls.push(batch)
          completions.push(resolve)
        })
    )

    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls.map((batch) => batch[0]!.executionHostId)).toEqual([
      'ssh:dev-box',
      'runtime:server-1'
    ])
    completions[0]!()
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2]).toHaveLength(1)
    completions[1]!()
    completions[2]!()
    await pending
  })

  it('recovers a missing sleeping name after failure and a transcript path arrives for the same session', async () => {
    const store = makeState({
      executionHostId: 'runtime:server-1',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore',
      sleeping: true
    })
    const paneKey = 'tab-1:00000000-0000-4000-8000-000000000001'
    const record = store.getState().sleepingAgentSessionsByPaneKey[paneKey]!
    store.update({
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: { ...record, providerSession: { key: 'session_id', id: 'codex-session' } }
      }
    })
    const resolveSessionTitles = vi
      .fn()
      .mockRejectedValueOnce(new Error('Host connecting'))
      .mockResolvedValueOnce({ titles: [] })
      .mockResolvedValue(titleResult('codex', 'Recovered conversation'))
    const stop = startAiVaultTabTitleSync({ ...store, resolveSessionTitles })
    try {
      await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalledTimes(1))
      store.update({
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            ...record,
            providerSession: {
              key: 'session_id',
              id: 'codex-session',
              transcriptPath: '/sessions/arrived.jsonl'
            }
          }
        }
      })
      await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalledTimes(2))
      store.update({
        tabsByWorktree: {
          'worktree-1': [
            ...store.getState().tabsByWorktree['worktree-1'],
            { ...store.getState().tabsByWorktree['worktree-1'][0], id: 'unrelated-tab' }
          ]
        }
      })
      await vi.waitFor(() =>
        expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
          'Recovered conversation'
        )
      )
      expect(resolveSessionTitles.mock.calls[1]![0].requests[0].transcriptPath).toBe(
        '/sessions/arrived.jsonl'
      )
    } finally {
      stop()
    }
  })

  it('paces repeated failed live refreshes after a success and preserves the last name', async () => {
    vi.useFakeTimers()
    const store = makeState({
      executionHostId: 'local',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore'
    })
    const attempts: number[] = []
    const resolveSessionTitles = async () => {
      attempts.push(Date.now())
      if (attempts.length === 1) {
        return titleResult('codex', 'Stable conversation')
      }
      throw new Error('Host unavailable')
    }
    const delays: number[] = []
    const stop = startAiVaultTabTitleSync({
      ...store,
      resolveSessionTitles,
      setTimer: (callback, delay) => {
        delays.push(delay)
        if (delay === 0) {
          throw new Error('Expired attempt scheduled an immediate retry')
        }
        return setTimeout(callback, delay)
      }
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const started = attempts[0]!
      await vi.advanceTimersByTimeAsync(60_000)
      expect(attempts.map((time) => time - started)).toEqual([0, 20_000, 40_000, 60_000])
      expect(delays).toEqual([20_000, 20_000, 20_000, 20_000])
      expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
        'Stable conversation'
      )
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
})
