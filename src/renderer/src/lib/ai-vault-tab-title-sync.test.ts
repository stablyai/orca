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
})
