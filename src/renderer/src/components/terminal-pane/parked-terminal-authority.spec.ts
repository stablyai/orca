import { describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectFact } from '../../../../shared/terminal-side-effect-facts'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './agent-task-complete-policy'

import type { MockStoreState, ParkedWatcherTestInstance } from './parked-terminal-byte-watcher.test'

const PTY_ID = 'pty-parked-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const PANE_ID = 1

// Real agent-detection titles: braille spinner classifies as working,
// the "✳ " Claude prefix as idle, and both as Claude agents.
const WORKING_TITLE_OSC = '\x1b]0;⠋ Build feature\x07'
const IDLE_TITLE = '✳ Build feature'
const IDLE_TITLE_OSC = `\x1b]0;${IDLE_TITLE}\x07`

export function registerParkedTerminalAuthorityTests(context: {
  getStore: () => MockStoreState
  resetStore: () => void
  dispatchTerminalNotification: ReturnType<typeof vi.fn>
  startWatcher: (
    overrides?: Partial<ParkedTerminalByteWatcherOptions>
  ) => Promise<ParkedWatcherTestInstance>
  emit: (data: string) => void
  flushSideEffects: () => void
}): void {
  const { dispatchTerminalNotification, startWatcher, emit, flushSideEffects } = context
  describe('with main side-effect authority on', () => {
    function enableMainAuthority(): void {
      context.getStore().settings = {
        ...context.getStore().settings,
        terminalMainSideEffectAuthority: true
      }
    }

    async function dispatchFacts(
      facts: TerminalSideEffectFact[],
      options: { seq?: number; replay?: boolean } = {}
    ): Promise<void> {
      const handler = await import('./terminal-side-effect-facts-handler')
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: PTY_ID,
        seq: options.seq ?? 0,
        ...(options.replay ? { replay: true } : {}),
        facts
      })
    }

    /** Feed chunks the way OrcaRuntimeService.onPtyData does: OSC 9999 strip,
     *  shared title tracker, one fact batch per chunk — the main half of the
     *  migration-safety parity check. */
    async function emitViaMainTrackerFacts(chunks: string[]): Promise<void> {
      const { createAgentStatusOscProcessor } = await import('../../../../shared/agent-status-osc')
      const { createTerminalTitleTracker } =
        await import('../../../../shared/terminal-output-side-effects')
      const handler = await import('./terminal-side-effect-facts-handler')
      const processStatusChunk = createAgentStatusOscProcessor()
      let pending: TerminalSideEffectFact[] = []
      const tracker = createTerminalTitleTracker({
        onTitle: (normalizedTitle, rawTitle) =>
          pending.push({ kind: 'title', normalizedTitle, rawTitle }),
        onAgentBecameWorking: () => pending.push({ kind: 'agent-working' }),
        onAgentBecameIdle: (title) => pending.push({ kind: 'agent-idle', title }),
        onAgentExited: () => pending.push({ kind: 'agent-exited' }),
        onBell: () => pending.push({ kind: 'bell' })
      })
      let seq = 0
      for (const chunk of chunks) {
        seq += chunk.length
        tracker.handleChunk(processStatusChunk(chunk).cleanData)
        if (pending.length > 0) {
          handler._dispatchTerminalSideEffectBatchForTest({ ptyId: PTY_ID, seq, facts: pending })
          pending = []
        }
      }
      tracker.dispose()
    }

    type RecordedCall = [string, ...unknown[]]

    /** Wrap the policy-visible store actions so byte mode and fact mode can be
     *  compared as one ordered outcome sequence. Timestamps are masked. */
    function recordPolicyOutcomes(): RecordedCall[] {
      const calls: RecordedCall[] = []
      context.getStore().setRuntimePaneTitle.mockImplementation((...args: unknown[]) => {
        calls.push(['setRuntimePaneTitle', ...args])
      })
      context.getStore().updateTabTitle.mockImplementation((...args: unknown[]) => {
        calls.push(['updateTabTitle', ...args])
      })
      context.getStore().markTerminalBell.mockImplementation((...args: unknown[]) => {
        calls.push(['markTerminalBell', ...args])
      })
      context.getStore().setCacheTimerStartedAt.mockImplementation((key: unknown, at: unknown) => {
        calls.push(['setCacheTimerStartedAt', key, typeof at === 'number' ? '<ts>' : at])
      })
      dispatchTerminalNotification.mockImplementation((...args: unknown[]) => {
        calls.push(['dispatchTerminalNotification', ...args])
      })
      return calls
    }

    it('does not consume bytes: a byte BEL produces no unread or notification', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      emit('build finished\x07')
      flushSideEffects()
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)

      expect(context.getStore().markTerminalBell).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('settles Command Code facts through the execution policy', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()
      await dispatchFacts([{ kind: 'command-code-working', prompt: 'Fix the spinner' }])
      expect(context.getStore().agentStatusByPaneKey[PANE_KEY]).toEqual(
        expect.objectContaining({
          state: 'working',
          prompt: 'Fix the spinner',
          agentType: 'command-code'
        })
      )
      await dispatchFacts([{ kind: 'command-code-done', prompt: 'Fix the spinner' }])
      await vi.advanceTimersByTimeAsync(2000)
      expect(context.getStore().agentStatusByPaneKey[PANE_KEY]).toEqual(
        expect.objectContaining({
          state: 'done',
          prompt: 'Fix the spinner',
          agentType: 'command-code'
        })
      )
      dispose()
    })

    it('does not request a title snapshot for an ordinary parked watcher', async () => {
      enableMainAuthority()
      const getSideEffectSnapshot = vi.fn()
      ;(
        window as unknown as {
          api: { pty: { getSideEffectSnapshot: typeof getSideEffectSnapshot } }
        }
      ).api.pty.getSideEffectSnapshot = getSideEffectSnapshot

      const { dispose } = await startWatcher()

      expect(getSideEffectSnapshot).not.toHaveBeenCalled()
      dispose()
    })

    it('restores a cold-started watcher title without replaying attention facts', async () => {
      enableMainAuthority()
      const getSideEffectSnapshot = vi.fn().mockResolvedValue({
        ptyId: PTY_ID,
        seq: 42,
        replay: true,
        facts: [
          { kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE },
          { kind: 'bell' },
          { kind: 'agent-idle', title: IDLE_TITLE }
        ] satisfies TerminalSideEffectFact[]
      })
      ;(
        window as unknown as {
          api: { pty: { getSideEffectSnapshot: typeof getSideEffectSnapshot } }
        }
      ).api.pty.getSideEffectSnapshot = getSideEffectSnapshot

      const { dispose } = await startWatcher({ restoreTitleOnRegister: true })
      await Promise.resolve()

      expect(getSideEffectSnapshot).toHaveBeenCalledWith(PTY_ID)
      expect(context.getStore().setRuntimePaneTitle).toHaveBeenCalledWith(
        TAB_ID,
        PANE_ID,
        IDLE_TITLE
      )
      expect(context.getStore().updateTabTitle).toHaveBeenCalledWith(TAB_ID, IDLE_TITLE)
      expect(context.getStore().markTerminalBell).not.toHaveBeenCalled()
      expect(context.getStore().setCacheTimerStartedAt).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('applies bell facts with the byte-mode policy: unread now, OS notification delayed', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([{ kind: 'bell' }])

      expect(context.getStore().markTerminalBell).toHaveBeenCalledWith({
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        paneKey: PANE_KEY
      })
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
        source: 'terminal-bell',
        paneKey: PANE_KEY,
        ptyId: PTY_ID,
        workspaceOwner: { executionHostId: 'local', runtimeEnvironmentId: null }
      })
      dispose()
    })

    it('fires the cache timer and completion from working→idle facts', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([
        { kind: 'title', normalizedTitle: '⠋ Build feature', rawTitle: '⠋ Build feature' },
        { kind: 'agent-working' }
      ])
      expect(context.getStore().setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)

      await dispatchFacts([
        { kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE },
        { kind: 'agent-idle', title: IDLE_TITLE }
      ])
      expect(context.getStore().setCacheTimerStartedAt).toHaveBeenLastCalledWith(
        PANE_KEY,
        expect.any(Number)
      )

      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
        source: 'agent-task-complete',
        terminalTitle: IDLE_TITLE,
        paneKey: PANE_KEY,
        ptyId: PTY_ID,
        workspaceOwner: { executionHostId: 'local', runtimeEnvironmentId: null }
      })
      dispose()
    })

    it('clears state without completion attention for stale-derived idle facts', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([
        { kind: 'title', normalizedTitle: '⠋ Build feature', rawTitle: '⠋ Build feature' },
        { kind: 'agent-working' }
      ])
      // Main's unthrottled 3s stale-title rewrite: titles/cache clear, but a
      // merely-paused agent must not earn a task-complete notification.
      await dispatchFacts([
        {
          kind: 'title',
          normalizedTitle: 'Build feature',
          rawTitle: 'Build feature',
          staleWorkingTitleClear: true
        },
        { kind: 'agent-idle', title: 'Build feature', staleWorkingTitleClear: true }
      ])

      expect(context.getStore().setRuntimePaneTitle).toHaveBeenLastCalledWith(
        TAB_ID,
        PANE_ID,
        'Build feature'
      )
      expect(context.getStore().setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      expect(context.getStore().markTerminalBell).not.toHaveBeenCalled()
      dispose()
    })

    it('replay batches restore the title only — attention facts never replay', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts(
        [
          { kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE },
          { kind: 'bell' },
          { kind: 'agent-idle', title: IDLE_TITLE }
        ],
        { replay: true }
      )
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)

      expect(context.getStore().setRuntimePaneTitle).toHaveBeenCalledWith(
        TAB_ID,
        PANE_ID,
        IDLE_TITLE
      )
      expect(context.getStore().markTerminalBell).not.toHaveBeenCalled()
      expect(context.getStore().setCacheTimerStartedAt).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('stays silent on a main 2031-subscribe fact', async () => {
      // Regression pin (#9993): the fact records a subscription for theme-flip
      // pushes; a parked watcher must never answer it.
      enableMainAuthority()
      const { dispose, ptyWrite } = await startWatcher()

      emit('\x1b[?2031h')
      await dispatchFacts([{ kind: '2031-subscribe' }])
      expect(ptyWrite).not.toHaveBeenCalled()

      // Why: pr-link facts arrive on the channel; byte-scanning here too
      // would observe every link twice.
      emit('PR: https://github.com/orca-dev/orca/pull/42\r\n')
      expect(context.getStore().observeTerminalGitHubPullRequestLink).not.toHaveBeenCalled()
      dispose()
    })

    it('marks the PTY hidden for delivery on start and clears it on dispose', async () => {
      enableMainAuthority()
      const setHiddenRendererPty = vi.fn()
      ;(
        window as unknown as { api: { pty: Record<string, unknown> } }
      ).api.pty.setHiddenRendererPty = setHiddenRendererPty
      const { dispose } = await startWatcher()

      expect(setHiddenRendererPty).toHaveBeenCalledWith(PTY_ID, true)

      dispose()
      // Why: the unhide must land before reveal re-registers pane handlers —
      // the watcher registry disposes watchers before the remount effect runs.
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith(PTY_ID, false)
    })

    it('sets no hidden bit and stays silent on 2031 when the gate kill switch is off', async () => {
      enableMainAuthority()
      context.getStore().settings = {
        ...context.getStore().settings,
        terminalHiddenDeliveryGate: false
      }
      const setHiddenRendererPty = vi.fn()
      ;(
        window as unknown as { api: { pty: Record<string, unknown> } }
      ).api.pty.setHiddenRendererPty = setHiddenRendererPty
      const { dispose, ptyWrite } = await startWatcher()

      // Gate off — bytes keep flowing, and they still elicit nothing (#9993).
      emit('\x1b[?20')
      emit('31h')
      await dispatchFacts([{ kind: '2031-subscribe' }])

      expect(ptyWrite).not.toHaveBeenCalled()
      expect(setHiddenRendererPty).not.toHaveBeenCalled()
      dispose()
    })

    it('observes PR links from pr-link facts with worktree attribution', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      const link = {
        url: 'https://github.com/orca-dev/orca/pull/421',
        slug: { owner: 'orca-dev', repo: 'orca', host: 'github.com' },
        number: 421
      }
      await dispatchFacts([{ kind: 'pr-link', link }])

      expect(context.getStore().observeTerminalGitHubPullRequestLink).toHaveBeenCalledTimes(1)
      expect(context.getStore().observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
        WORKTREE_ID,
        link,
        expect.objectContaining({ tabId: TAB_ID, ptyId: PTY_ID })
      )
      dispose()
    })

    it('execution retirement ends facts and clears a written title slot', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([{ kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE }])
      expect(context.getStore().setRuntimePaneTitle).toHaveBeenCalledWith(
        TAB_ID,
        PANE_ID,
        IDLE_TITLE
      )

      const handler = await import('./terminal-side-effect-facts-handler')
      handler.observeTerminalSemanticResidentExit(PTY_ID, 0)
      dispose()
      expect(context.getStore().clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID)

      await dispatchFacts([{ kind: 'bell' }])
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)
      expect(context.getStore().markTerminalBell).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    })

    // The key migration-safety check: the same bytes produce the identical
    // ordered store outcome whether the watcher parses them directly (kill
    // switch off) or consumes main-derived facts over the channel.
    it('produces identical store outcomes via the channel as the byte parser did', async () => {
      const fixtureChunks = [WORKING_TITLE_OSC, 'agent response body\r\n', `${IDLE_TITLE_OSC}\x07`]

      // Pass 1: legacy byte-parser mode.
      const byteModeCalls = recordPolicyOutcomes()
      {
        const { dispose } = await startWatcher()
        for (const chunk of fixtureChunks) {
          emit(chunk)
          flushSideEffects()
        }
        await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
        dispose()
      }

      // Pass 2: fresh modules/store, authority on, facts derived by the
      // shared main tracker from the same bytes.
      vi.resetModules()
      context.resetStore()
      dispatchTerminalNotification.mockReset()
      const factModeCalls = recordPolicyOutcomes()
      {
        enableMainAuthority()
        const { dispose } = await startWatcher()
        await emitViaMainTrackerFacts(fixtureChunks)
        await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
        dispose()
      }

      expect(byteModeCalls.length).toBeGreaterThan(0)
      expect(factModeCalls).toEqual(byteModeCalls)
    })
  })
}
