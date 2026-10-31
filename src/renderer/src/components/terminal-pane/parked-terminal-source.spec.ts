import { expect, it, vi } from 'vitest'
import type { MockStoreState, ParkedWatcherTestInstance } from './parked-terminal-byte-watcher.test'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import type { RuntimeTerminalDataSubscriptionOptions } from '@/runtime/runtime-terminal-stream'
import type { TerminalSideEffectFact } from '../../../../shared/terminal-side-effect-facts'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './agent-task-complete-policy'

const PTY_ID = 'pty-parked-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PANE_ID = 1
const IDLE_TITLE = '✳ Build feature'

export function registerParkedTerminalSourceTests(context: {
  getStore: () => MockStoreState
  startWatcher: (
    options?: Partial<ParkedTerminalByteWatcherOptions>
  ) => Promise<ParkedWatcherTestInstance>
  dispatchTerminalNotification: ReturnType<typeof vi.fn>
  emit: (data: string) => void
  getOnData: () => unknown
  holdRemoteAdmission: () => void
  getRemoteSubscriptions: () => {
    options?: RuntimeTerminalDataSubscriptionOptions
    data: (data: string, meta?: { seq?: number }) => void
    close: ReturnType<typeof vi.fn>
  }[]
}): void {
  const { dispatchTerminalNotification, emit } = context
  it.each([
    ['local main-authority', 'pty-parked-1'],
    ['SSH through main', 'ssh:connection-1@@pty-1'],
    ['WSL facts', 'wsl-pty-1'],
    ['parked paired', 'remote:env-1@@terminal-1']
  ])('production Uprime retains the bounded old-host bell: %s', async (_route, ptyId) => {
    context.getStore().settings = {
      ...context.getStore().settings,
      terminalMainSideEffectAuthority: true
    }
    const pty = window.api.pty
    const admission = Promise.withResolvers<boolean>()
    Object.assign(pty, { hasPty: vi.fn(() => admission.promise) })
    context.holdRemoteAdmission()
    const pinned = Boolean(process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT)
    const pinnedRoot = process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT
    const watcher = pinned
      ? await import(/* @vite-ignore */ `${pinnedRoot}/parked-terminal-byte-watcher.ts`)
      : await import('./parked-terminal-byte-watcher')
    const handler = pinned
      ? await import(/* @vite-ignore */ `${pinnedRoot}/terminal-side-effect-facts-handler.ts`)
      : await import('./terminal-side-effect-facts-handler')
    const options = {
      ptyId,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID
    }
    // Reveal removes presentation before the next watcher; the bell has no consumer.
    const first = watcher.startParkedTerminalByteWatcher(options)
    first()
    handler.dispatchTerminalSideEffectBatch({ ptyId, seq: 1, facts: [{ kind: 'bell' }] })
    expect(context.getStore().markTerminalBell).not.toHaveBeenCalled()
    const next = watcher.startParkedTerminalByteWatcher(options)
    admission.resolve(true)
    for (const subscription of context.getRemoteSubscriptions()) {
      subscription.options?.onAdmitted?.()
    }
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect.soft(context.getStore().markTerminalBell).toHaveBeenCalledOnce()
    expect
      .soft(dispatchTerminalNotification)
      .toHaveBeenCalledWith(
        WORKTREE_ID,
        expect.objectContaining({ source: 'terminal-bell', ptyId, paneKey: PANE_KEY })
      )
    console.info('production-Uprime', {
      pinned,
      route: _route,
      attention: context.getStore().markTerminalBell.mock.calls.length,
      notifications: dispatchTerminalNotification.mock.calls.length
    })
    next()
    handler._resetTerminalSideEffectFactConsumersForTest()
  })

  it('R2-C2 consumes a capable unattributed live bell while lookup remains pending', async () => {
    context.getStore().settings = {
      ...context.getStore().settings,
      terminalMainSideEffectAuthority: true
    }
    const admission = Promise.withResolvers<boolean>()
    Object.assign(window.api.pty, { hasPty: vi.fn(() => admission.promise) })
    const { TerminalSnapshotState } = await import('../../../../shared/terminal-snapshot-state')
    const pinnedRoot = process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT
    const handler = pinnedRoot
      ? await import(/* @vite-ignore */ `${pinnedRoot}/terminal-side-effect-facts-handler.ts`)
      : await import('./terminal-side-effect-facts-handler')
    const watcher = pinnedRoot
      ? await import(/* @vite-ignore */ `${pinnedRoot}/parked-terminal-byte-watcher.ts`)
      : await import('./parked-terminal-byte-watcher')
    const dispose = watcher.startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID
    })
    const source = new TerminalSnapshotState()
    const deliver = (replay: boolean) =>
      handler.dispatchTerminalSideEffectBatch({
        ptyId: PTY_ID,
        seq: source.state.revision,
        replay,
        facts: replay ? [] : [{ kind: 'bell' }],
        terminalState: {
          runtimeId: 'runtime-1',
          incarnationId: 'incarnation-1',
          snapshot: source.snapshot()
        }
      })
    deliver(true)
    source.record({ kind: 'bell' })
    deliver(false)
    await vi.advanceTimersByTimeAsync(16_000)
    admission.resolve(true)
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    dispose()
    expect(context.getStore().markTerminalBell).toHaveBeenCalledOnce()
    expect(dispatchTerminalNotification).toHaveBeenCalledOnce()
  })

  it('keeps the same parser and controllers through legacy retry, capable upgrade and obsolete callbacks', async () => {
    const ptyId = 'remote:env-1@@terminal-1'
    const handler = await import('./terminal-side-effect-facts-handler')
    const { TerminalSnapshotState } = await import('../../../../shared/terminal-snapshot-state')
    const state = new TerminalSnapshotState()
    const deliver = (runtimeId: string, incarnationId = 'physical', baseline = false) => {
      handler.dispatchTerminalSideEffectBatch(
        {
          ptyId,
          paneKey: PANE_KEY,
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          seq: state.state.revision,
          facts: [],
          replay: baseline,
          terminalState: { runtimeId, incarnationId, snapshot: state.snapshot() }
        },
        baseline ? { baseline: true, source: capableSource } : undefined
      )
    }
    const capableSource = { onResponse: vi.fn() }
    deliver('runtime-1', 'physical', true)
    const resident = handler.getTerminalSemanticResident(ptyId)!
    const policy = resident.policy
    const legacySource = policy.legacySource
    handler.installTerminalSideEffectSource('env-1', { onResponse: vi.fn() }, false)
    await vi.advanceTimersByTimeAsync(0)
    const first = context.getRemoteSubscriptions().at(-1)!
    expect(first).toBeDefined()
    first.data('\x1b]0;part', { seq: 9 })
    first.options?.onTransportClose?.({ reason: 'closed' } as never)
    await vi.advanceTimersByTimeAsync(250)
    const retry = context.getRemoteSubscriptions().at(-1)!
    expect(retry).not.toBe(first)
    expect(first.close).toHaveBeenCalledOnce()
    retry.data('ial\x07', { seq: 13 })
    await vi.advanceTimersByTimeAsync(0)
    expect(context.getStore().updateTabTitle).toHaveBeenCalledWith(TAB_ID, 'partial')
    expect(handler.getTerminalSemanticResident(ptyId)).toBe(resident)
    expect(resident.policy).toBe(policy)
    expect(resident.policy.legacySource).toBe(legacySource)
    const before = context.getStore().markTerminalBell.mock.calls.length
    retry.data('\x07', { seq: 14 })
    await vi.advanceTimersByTimeAsync(0)
    expect(context.getStore().markTerminalBell).toHaveBeenCalledTimes(before + 1)
    handler.installTerminalSideEffectSource('env-1', capableSource, true)
    state.record({ kind: 'bell' })
    deliver('runtime-2', 'physical', true)
    expect(context.getStore().markTerminalBell).toHaveBeenCalledTimes(before + 1)
    first.data('\x07', { seq: 15 })
    retry.data('\x07', { seq: 15 })
    retry.options?.onEnd?.('exited')
    expect(resident.isLive).toBe(true)
    state.record({ kind: 'bell' })
    deliver('runtime-2')
    expect(context.getStore().markTerminalBell).toHaveBeenCalledTimes(before + 2)
    expect(handler.getTerminalSemanticResident(ptyId)).toBe(resident)
    expect(retry.close).toHaveBeenCalledOnce()
    deliver('runtime-2', 'replacement', true)
    expect(resident.isLive).toBe(true)
    handler.installTerminalSideEffectSource('env-1', { onResponse: vi.fn() }, false)
    await vi.advanceTimersByTimeAsync(0)
    context.getRemoteSubscriptions().at(-1)?.options?.onAdmitted?.({
      ptyId: 'terminal-1',
      incarnationId: 'replacement'
    })
    expect(resident.isLive).toBe(false)
    expect(handler.getTerminalSemanticResident(ptyId)).not.toBe(resident)
  })

  it('production Uprime retains the local authority-OFF raw-buffer bell', async () => {
    const admission = Promise.withResolvers<boolean>()
    Object.assign(window.api.pty, { hasPty: vi.fn(() => admission.promise) })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { replayPreHandlerPtyData } = await import('./pty-pre-handler-buffer')
    ensurePtyDispatcher()
    const pinned = Boolean(process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT)
    const pinnedRoot = process.env.ORCA_PR31182_PINNED_MAIN_PARITY_ROOT
    const watcher = pinned
      ? await import(/* @vite-ignore */ `${pinnedRoot}/parked-terminal-byte-watcher.ts`)
      : await import('./parked-terminal-byte-watcher')
    const dispose = watcher.startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID
    })
    expect(context.getOnData()).toBeTypeOf('function')
    emit('\x07')
    const retained = vi.fn()
    replayPreHandlerPtyData(PTY_ID, (data) => retained(data))
    expect(retained).toHaveBeenCalledWith('\x07')
    admission.resolve(true)
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    console.info('production-Uprime-raw-buffer', {
      pinned,
      retainedBytes: retained.mock.calls.map(([data]) => data).join(''),
      attention: context.getStore().markTerminalBell.mock.calls.length,
      notifications: dispatchTerminalNotification.mock.calls.length
    })
    expect.soft(context.getStore().markTerminalBell).toHaveBeenCalledOnce()
    expect
      .soft(dispatchTerminalNotification)
      .toHaveBeenCalledWith(
        WORKTREE_ID,
        expect.objectContaining({ source: 'terminal-bell', ptyId: PTY_ID, paneKey: PANE_KEY })
      )
    dispose()
  })

  it.each(['command-finished', 'agent-idle', 'agent-status', 'command-code-done'] as const)(
    'keeps the original absent subject on retained %s without losing its independent bell',
    async (kind) => {
      context.getStore().settings = {
        ...context.getStore().settings,
        terminalMainSideEffectAuthority: true
      }
      const admission = Promise.withResolvers<boolean>()
      Object.assign(window.api.pty, { hasPty: vi.fn(() => admission.promise) })
      const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
      const handler = await import('./terminal-side-effect-facts-handler')
      const dispose = startParkedTerminalByteWatcher({
        ptyId: PTY_ID,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneId: PANE_ID
      })
      const fact: TerminalSideEffectFact =
        kind === 'command-finished'
          ? { kind, exitCode: 0 }
          : kind === 'agent-idle'
            ? { kind, title: IDLE_TITLE }
            : kind === 'agent-status'
              ? { kind, payload: { state: 'done', prompt: 'old', agentType: 'codex' } }
              : { kind, prompt: 'old' }
      dispose()
      handler.dispatchTerminalSideEffectBatch({
        ptyId: PTY_ID,
        seq: 1,
        facts: [fact, { kind: 'bell' }]
      })
      const state = context.getStore()
      const newer = {
        paneKey: PANE_KEY,
        state: 'working' as const,
        prompt: 'new',
        agentType: 'codex' as const,
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        stateHistory: []
      }
      state.agentStatusByPaneKey[PANE_KEY] = newer
      const launch = { identity: { agentType: 'codex' }, launchToken: 'new' }
      Object.assign(state.agentLaunchConfigByPaneKey, { [PANE_KEY]: launch })
      admission.resolve(true)
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(state.agentStatusByPaneKey[PANE_KEY]).toBe(newer)
      expect(state.agentLaunchConfigByPaneKey[PANE_KEY]).toBe(launch)
      expect(state.markTerminalBell).toHaveBeenCalledOnce()
      expect(dispatchTerminalNotification).toHaveBeenCalledOnce()
    }
  )
}
