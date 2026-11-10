import { describe, expect, it, vi } from 'vitest'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import { removeLayoutLeaf } from '../../../../../../shared/workspace-layout/terminal-pane-tree'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { resolveTerminalTabTitle } from '../../../../../../shared/tab-title-resolution'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AiVaultTitleRequest } from './ai-vault-tab-title-requests'
import { settleAiVaultTitleRequestBatches } from './ai-vault-tab-title-batches'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'

import { makeState, titleResult } from './ai-vault-tab-title-test-fixture'

describe('AI Vault tab title sync', () => {
  it.each(['close', 'authority retirement', 'placement prune', 'providerless successor'])(
    'names the remaining conversation after %s of a non-active departed pane',
    async (change) => {
      const store = createTestStore()
      const a = '00000000-0000-4000-8000-000000000001'
      const b = '00000000-0000-4000-8000-000000000002'
      const c = '00000000-0000-4000-8000-000000000003'
      const paneA = `tab-1:${a}`
      const layout: AppState['terminalLayoutsByTabId'][string] = {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: a },
          second: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: b },
            second: { type: 'leaf', leafId: c }
          }
        },
        activeLeafId: c,
        expandedLeafId: null,
        ptyIdsByLeafId: { [c]: 'pty-shell' }
      }
      store.setState({
        activeWorktreeId: 'wt-title',
        activeWorkspaceExecutionHostId: 'local',
        tabsByWorktree: {
          'wt-title': [makeTab({ id: 'tab-1', worktreeId: 'wt-title', ptyId: 'pty-shell' })]
        },
        terminalLayoutsByTabId: { 'tab-1': layout }
      })
      for (const [leaf, id] of [
        [a, 'conversation-a'],
        [b, 'conversation-b']
      ]) {
        const key = `tab-1:${leaf}`
        store
          .getState()
          .setAgentStatus(
            key,
            { state: 'done', prompt: 'finished task', agentType: 'codex' },
            undefined,
            { updatedAt: 1000, stateStartedAt: 1000, turnStartedAt: 1000 },
            { tabId: 'tab-1', worktreeId: 'wt-title' },
            { providerSession: { key: 'session_id', id } }
          )
        store.getState().dropAgentStatus(key)
      }
      const resolveSessionTitles = vi.fn(async (args: AiVaultSessionTitlesArgs) => ({
        titles: args.requests.map(({ agent, sessionId }) => ({
          agent,
          sessionId,
          title: sessionId === 'conversation-a' ? 'First conversation' : 'Second conversation',
          kind: 'named' as const
        }))
      }))
      const stop = startAiVaultTabTitleSync({
        getState: store.getState,
        subscribe: store.subscribe,
        resolveSessionTitles
      })
      try {
        await vi.waitFor(() =>
          expect(store.getState().tabsByWorktree['wt-title'][0].aiVaultTitle?.title).toBe(
            'First conversation'
          )
        )
        if (change === 'close') {
          store.getState().dropAgentStatus(paneA, { paneRemoved: true })
        } else if (change === 'authority retirement') {
          store.getState().retireAgentPaneAuthority(paneA)
        } else if (change === 'providerless successor') {
          store
            .getState()
            .setAgentStatus(
              paneA,
              { state: 'working', prompt: 'new task', agentType: 'codex' },
              undefined,
              { updatedAt: 2000, stateStartedAt: 2000, turnStartedAt: 2000 },
              { tabId: 'tab-1', worktreeId: 'wt-title' }
            )
        }
        if (change === 'close' || change === 'placement prune') {
          store.getState().setTabLayout('tab-1', {
            ...layout,
            root: removeLayoutLeaf(layout.root, a)
          })
        }
        await vi.waitFor(() =>
          expect(store.getState().tabsByWorktree['wt-title'][0].aiVaultTitle).toMatchObject({
            agent: 'codex',
            sessionId: 'conversation-b',
            title: 'Second conversation'
          })
        )
        expect(resolveTerminalTabTitle(store.getState().tabsByWorktree['wt-title'][0], false)).toBe(
          'Second conversation'
        )
      } finally {
        stop()
      }
    }
  )

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

  it('asks once for a sleeping title saved before titles carried a kind', async () => {
    const store = makeState({
      executionHostId: 'ssh:dev-box',
      worktreeId: 'worktree-1',
      path: '/workspace/albacore',
      sleeping: true,
      aiVaultTitle: { agent: 'codex', sessionId: 'codex-session', title: 'Login cleanup' }
    })
    const resolveSessionTitles = vi.fn(async () => ({
      titles: [
        {
          agent: 'codex' as const,
          sessionId: 'codex-session',
          title: 'Login cleanup',
          kind: 'named' as const
        }
      ]
    }))
    const stop = startAiVaultTabTitleSync({ ...store, resolveSessionTitles })

    await vi.waitFor(() =>
      expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.kind).toBe('named')
    )
    const tab = store.getState().tabsByWorktree['worktree-1'][0] as TerminalTab
    expect(resolveTerminalTabTitle({ ...tab, quickCommandLabel: 'Codex High' }, false)).toBe(
      'Login cleanup'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolveSessionTitles).toHaveBeenCalledTimes(1)
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
