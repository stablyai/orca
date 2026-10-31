import { expect, it, vi, type Mock } from 'vitest'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import type { PaneConnectionDeps } from './pty-connection-test-deps'
import type { PanePtyBinding } from './pty-connection/pane-pty-binding'
import type { StoreState } from './pty-connection-test-store-state'

type MainOwnedResumeFixture = {
  mainResume: Mock<(pane: unknown, automatic?: boolean) => Promise<boolean>>
  transport: MockTransport
  deps: PaneConnectionDeps
  binding: PanePtyBinding
  paneKey: string
  record: unknown
  owner: { worktreeId: string; tabId: string; leafId: string }
  onDeferredCwdSpawnFailed: Mock
}

export function registerMainOwnedResumeDrainTests(
  mainOwnedResumeFixture: () => Promise<MainOwnedResumeFixture>,
  getStoreState: () => StoreState,
  enableRealDrain: () => void
): void {
  it.each([
    'timer',
    'parked-reveal',
    'inflight-reveal',
    'sleep',
    'false',
    'cancel',
    'dispose',
    'teardown',
    'generation',
    'transport',
    'superseded',
    'paused'
  ] as const)(
    'retains the production drain obligation across transient failure: %s',
    async (ending) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      enableRealDrain()
      window.api.runtime.call = vi.fn<typeof window.api.runtime.call>(async () => ({
        id: 'automatic-work-status',
        ok: true,
        _meta: { runtimeId: 'local-runtime' },
        result: { automaticWork: { mode: { kind: 'normal' } } }
      }))
      const helper = await import('./pty-connection/main-resumed-sleep-pane')
      const attach = vi.spyOn(helper, 'attachToMainResumedSleepPane')
      const recovery = await import('./terminal-pane-recovery')
      const settled = vi.spyOn(recovery, 'settleTerminalPaneRecovery')
      const {
        mainResume,
        transport,
        deps,
        binding,
        paneKey,
        record,
        owner,
        onDeferredCwdSpawnFailed
      } = await mainOwnedResumeFixture()
      const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
      expect(mainResume).toHaveBeenCalledTimes(1)
      expect(attach.mock.calls, 'main-helper call-through spy').toHaveLength(1)
      const [session, , startup, options] = attach.mock.calls[0]
      const original = session.deferredSpawn
      const timeout = new Error(
        "Error invoking remote method 'worktrees:resumeSleptPane': Error: Request createOrAttach timed out after 60000ms"
      )
      const tick = async (ms: number) => {
        const before = mainResume.mock.calls.length
        await vi.advanceTimersByTimeAsync(ms - 1)
        expect(mainResume).toHaveBeenCalledTimes(before)
        await vi.advanceTimersByTimeAsync(1)
        await flushAsyncTicks(30)
        expect(mainResume).toHaveBeenCalledTimes(before + 1)
      }
      const expectParked = (failed: number) => {
        expect(session.deferredSpawn).toEqual(original)
        expect(session.deferredSpawn?.startupOverride).toBe(startup)
        expect(session.deferredSpawn?.options).toBe(options)
        expect(getPaneSpawnDeferral(paneKey)).toMatchObject({ reason: 'live_cap' })
        expect(getPaneSpawnDeferral(paneKey)?.resuming).not.toBe(true)
        expect(settled.mock.calls.filter(([, , status]) => status === 'failed')).toHaveLength(
          failed
        )
        expect(onDeferredCwdSpawnFailed).toHaveBeenCalledTimes(failed)
        expect(transport.connect).not.toHaveBeenCalled()
        expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
        expect(getStoreState().clearSleepingAgentSession).not.toHaveBeenCalled()
        expect(getStoreState().sleepingAgentSessionsByPaneKey[paneKey]).toBe(record)
      }
      deps.isVisibleRef.current = false
      await tick(30_000) // repeated typed capacity refusal through the real host drain
      mainResume.mockRejectedValue(timeout)
      await tick(60_000)
      expectParked(3) // old source loses source, control and timer here
      expect(mainResume).toHaveBeenLastCalledWith(owner, true)

      if (ending === 'timer') {
        for (const delay of [120_000, 240_000, 300_000, 300_000]) {
          await tick(delay)
          expectParked(mainResume.mock.calls.length)
        }
        mainResume.mockResolvedValue(true) // legitimate daemon/capacity recovery
        await tick(300_000)
      } else if (ending === 'parked-reveal') {
        mainResume.mockResolvedValue(true)
        deps.isVisibleRef.current = true
        binding.noteVisibilityResume()
        await flushAsyncTicks(30)
        expect(mainResume).toHaveBeenLastCalledWith(owner, false)
      } else {
        const pending = createDeferred<boolean>()
        mainResume.mockImplementationOnce(() => pending.promise)
        await tick(120_000)
        if (ending === 'inflight-reveal') {
          deps.isVisibleRef.current = true
          binding.noteVisibilityResume()
          expect(mainResume).toHaveBeenCalledTimes(4)
          mainResume.mockRejectedValueOnce(new Error('terminal_spawn_deferred:pressure'))
        } else if (ending === 'cancel') {
          if (!startup.resumeSource) {
            throw new Error('missing saved resume source')
          }
          startup.resumeSource.cancelled = true
        } else if (ending === 'dispose') {
          binding.dispose()
        } else if (ending === 'teardown') {
          getStoreState().deleteStateByWorktreeId = { 'wt-1': { isDeleting: true } }
        } else if (ending === 'generation') {
          session.tabGeneration += 1
        } else if (ending === 'transport') {
          session.transportStreamGeneration += 1
        } else if (ending === 'superseded') {
          session.enterSpawnDeferredSleep('paused', startup, options, true)
        }
        if (ending === 'false') {
          pending.resolve(false)
        } else {
          pending.reject(
            ending === 'sleep'
              ? new Error(
                  "Error invoking remote method 'worktrees:resumeSleptPane': Error: worktree_terminals_sleeping"
                )
              : ending === 'paused'
                ? new Error('terminal_spawn_deferred:paused')
                : timeout
          )
        }
        await flushAsyncTicks(40)
        if (ending === 'inflight-reveal') {
          expect(mainResume).toHaveBeenCalledTimes(5)
          expect(mainResume).toHaveBeenLastCalledWith(owner, false)
          expect(getPaneSpawnDeferral(paneKey)?.reason).toBe('pressure')
          deps.isVisibleRef.current = false
          mainResume.mockResolvedValue(true)
          await tick(240_000)
          expect(mainResume).toHaveBeenLastCalledWith(owner, true)
        } else if (ending === 'paused' || ending === 'superseded') {
          expect(getPaneSpawnDeferral(paneKey)?.reason).toBe('paused')
          expect(session.deferredSpawn?.reason).toBe('paused')
          await vi.advanceTimersByTimeAsync(600_000)
          expect(mainResume).toHaveBeenCalledTimes(4)
          mainResume.mockResolvedValue(true)
          deps.isVisibleRef.current = true
          binding.noteVisibilityResume()
          await flushAsyncTicks(30)
        } else {
          expect(session.deferredSpawn).toBeNull()
          expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
          await vi.advanceTimersByTimeAsync(600_000)
          deps.isVisibleRef.current = true
          binding.noteVisibilityResume()
          await flushAsyncTicks(30)
          expect(mainResume).toHaveBeenCalledTimes(4)
          expect(transport.connect).not.toHaveBeenCalled()
          binding.dispose()
          return
        }
      }
      expect(transport.connect).toHaveBeenCalledExactlyOnceWith(
        expect.not.objectContaining({ command: expect.anything() })
      )
      expect(settled.mock.calls.filter(([, , status]) => status === 'success')).toHaveLength(1)
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledOnce()
      expect(getStoreState().clearSleepingAgentSession).toHaveBeenCalledExactlyOnceWith(paneKey)
      expect(transport.getPtyId()).toBe('main-pty')
      for (const [, pane, source] of attach.mock.calls) {
        expect(pane).toEqual(owner)
        expect(source).toBe(startup)
      }
      expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
      expect(session.deferredSpawn).toBeNull()
      const calls = mainResume.mock.calls.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(mainResume).toHaveBeenCalledTimes(calls)
      binding.dispose()
    }
  )

  it.each(
    ['workspace', 'fallback'].flatMap((shape) =>
      [100, 1_000].flatMap((population) =>
        ['recovery', 'cancel'].map((ending) => ({ shape, population, ending }))
      )
    )
  )(
    'bounds unknown retry work at $population tabs: $shape / $ending',
    async ({ shape, population, ending }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      enableRealDrain()
      window.api.runtime.call = vi.fn<typeof window.api.runtime.call>(async () => ({
        id: 'automatic-work-status',
        ok: true,
        _meta: { runtimeId: 'local-runtime' },
        result: { automaticWork: { mode: { kind: 'normal' } } }
      }))
      const helper = await import('./pty-connection/main-resumed-sleep-pane')
      const attach = vi.spyOn(helper, 'attachToMainResumedSleepPane')
      const tabs = await import('./pty-connection/terminal-tab-id')
      const lookup = vi.spyOn(tabs, 'findTerminalTabForPane')
      const { mainResume, transport, deps, binding, owner, paneKey } =
        await mainOwnedResumeFixture()
      const [session, , startup] = attach.mock.calls[0]
      const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
      let visits = 0
      const rows = Array.from({ length: population }, (_, index) => ({
        get id() {
          visits += 1
          return index === population - 1 ? owner.tabId : `unrelated-tab-${index}`
        },
        ptyId: null,
        generation: 0
      }))
      getStoreState().tabsByWorktree =
        shape === 'workspace'
          ? { [owner.worktreeId]: rows }
          : { [owner.worktreeId]: rows.slice(0, -1), 'moved-worktree': rows.slice(-1) }
      // Count actual row reads by the real resolver, including its all-workspaces fallback.
      const visitsPerLookup = shape === 'workspace' ? 2 * population : 3 * population - 2
      const timeout = new Error(
        "Error invoking remote method 'worktrees:resumeSleptPane': Error: Request createOrAttach timed out after 60000ms"
      )
      deps.isVisibleRef.current = false
      mainResume.mockRejectedValue(timeout)
      for (const delay of [30_000, 60_000, 120_000]) {
        visits = 0
        lookup.mockClear()
        const dispatched = mainResume.mock.calls.length
        await vi.advanceTimersByTimeAsync(delay)
        await flushAsyncTicks(30)
        expect(mainResume).toHaveBeenCalledTimes(dispatched + 1)
        expect(mainResume).toHaveBeenLastCalledWith(owner, true)
        expect(lookup).toHaveBeenCalledTimes(3)
        expect(visits).toBe(3 * visitsPerLookup)
        expect(session.deferredSpawn?.startupOverride).toBe(startup)
        expect(getPaneSpawnDeferral(paneKey)?.resuming).not.toBe(true)
        expect(transport.connect).not.toHaveBeenCalled()
      }
      visits = 0
      lookup.mockClear()
      if (ending === 'recovery') {
        mainResume.mockResolvedValue(true)
        await vi.advanceTimersByTimeAsync(240_000)
        await flushAsyncTicks(30)
        expect(mainResume).toHaveBeenCalledTimes(5)
        expect(lookup).toHaveBeenCalledTimes(3)
        expect(visits).toBe(3 * visitsPerLookup)
        expect(transport.getPtyId()).toBe('main-pty')
        expect(transport.connect).toHaveBeenCalledOnce()
        expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledOnce()
      } else {
        const pending = createDeferred<boolean>()
        mainResume.mockImplementationOnce(() => pending.promise)
        await vi.advanceTimersByTimeAsync(240_000)
        expect(mainResume).toHaveBeenCalledTimes(5)
        if (!startup.resumeSource) {
          throw new Error('missing saved resume source')
        }
        startup.resumeSource.cancelled = true
        pending.reject(timeout)
        await flushAsyncTicks(30)
        expect(lookup).toHaveBeenCalledTimes(2)
        expect(visits).toBe(2 * visitsPerLookup)
        expect(transport.connect).not.toHaveBeenCalled()
      }
      expect(session.deferredSpawn).toBeNull()
      expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
      lookup.mockClear()
      visits = 0
      await vi.advanceTimersByTimeAsync(600_000)
      expect(mainResume).toHaveBeenCalledTimes(5)
      expect(lookup).not.toHaveBeenCalled()
      expect(visits).toBe(0)
      binding.dispose()
    }
  )
}
