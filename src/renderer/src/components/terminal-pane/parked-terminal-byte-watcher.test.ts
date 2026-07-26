import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectFact } from '../../../../shared/terminal-side-effect-facts'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'

const PTY_ID = 'pty-parked-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PANE_ID = 1
// Mirrors PARKED_NOTIFICATION_GRACE_MS / AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS.
const NOTIFICATION_GRACE_MS = 250

// Real agent-detection titles: braille spinner classifies as working,
// the "✳ " Claude prefix as idle, and both as Claude agents.
const WORKING_TITLE_OSC = '\x1b]0;⠋ Build feature\x07'
const IDLE_TITLE = '✳ Build feature'
const IDLE_TITLE_OSC = `\x1b]0;${IDLE_TITLE}\x07`

type MockStoreState = {
  settings: {
    theme?: 'system' | 'dark' | 'light'
    promptCacheTimerEnabled?: boolean
    experimentalTerminalAttention?: boolean
    terminalMainSideEffectAuthority?: boolean
    terminalHiddenDeliveryGate?: boolean
    notifications?: { enabled?: boolean; agentTaskComplete?: boolean }
  } | null
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
}

const dispatchTerminalNotification = vi.fn()
let mockStoreState: MockStoreState

vi.mock('./use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))

vi.mock('@/lib/terminal-theme', () => ({
  getSystemPrefersDark: () => true
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

function createMockStoreState(): MockStoreState {
  return {
    // Why: terminalMainSideEffectAuthority false pins the legacy byte-parser
    // mode this suite was written for; the authority-on fact-consumer mode is
    // covered by the dedicated describe block below.
    settings: {
      theme: 'system',
      promptCacheTimerEnabled: true,
      experimentalTerminalAttention: false,
      terminalMainSideEffectAuthority: false,
      notifications: { enabled: true, agentTaskComplete: true }
    },
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabTitle: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    observeTerminalGitHubPullRequestLink: vi.fn()
  }
}

describe('startParkedTerminalByteWatcher', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null

  function emit(data: string): void {
    onData?.({ id: PTY_ID, data })
  }

  // The output processor defers title/bell side effects onto a 0ms drain timer.
  function flushSideEffects(): void {
    vi.advanceTimersByTime(0)
  }

  async function startWatcher(
    overrides: Partial<ParkedTerminalByteWatcherOptions> = {}
  ): Promise<{ dispose: () => void; sendInput: ReturnType<typeof vi.fn> }> {
    const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
    const sendInput = vi.fn()
    const dispose = startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID,
      sendInput,
      ...overrides
    })
    return { dispose, sendInput }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    onData = null
    mockStoreState = createMockStoreState()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        pty: {
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          ackData: vi.fn()
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('forwards every OSC title in order to the pane and tab title store actions', async () => {
    const { dispose } = await startWatcher()

    emit(`${WORKING_TITLE_OSC}${IDLE_TITLE_OSC}`)
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle.mock.calls).toEqual([
      [TAB_ID, PANE_ID, '⠋ Build feature'],
      [TAB_ID, PANE_ID, IDLE_TITLE]
    ])
    expect(mockStoreState.updateTabTitle.mock.calls).toEqual([
      [TAB_ID, '⠋ Build feature'],
      [TAB_ID, IDLE_TITLE]
    ])
    dispose()
  })

  it('drops the bare cursor-agent native title before it reaches the store', async () => {
    const { dispose } = await startWatcher()

    emit('\x1b]0;Cursor Agent\x07')
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle).not.toHaveBeenCalled()
    expect(mockStoreState.updateTabTitle).not.toHaveBeenCalled()
    dispose()
  })

  it('does not drive the tab title when drivesTabTitle is false', async () => {
    const { dispose } = await startWatcher({ drivesTabTitle: false })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)
    expect(mockStoreState.updateTabTitle).not.toHaveBeenCalled()
    dispose()
  })

  it('marks unread on BEL and schedules the delayed terminal-bell OS notification', async () => {
    const { dispose } = await startWatcher()

    emit('build finished\x07')
    flushSideEffects()

    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith(WORKTREE_ID)
    expect(mockStoreState.markTerminalTabUnread).toHaveBeenCalledWith(TAB_ID)
    expect(mockStoreState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'terminal-bell',
      paneKey: PANE_KEY
    })
    dispose()
  })

  it('marks the exact pane unread when experimental terminal attention is enabled', async () => {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: true
    }
    const { dispose } = await startWatcher()

    emit('\x07')
    flushSideEffects()

    expect(mockStoreState.markTerminalPaneUnread).toHaveBeenCalledWith(PANE_KEY)
    dispose()
  })

  it('does not treat an OSC-terminator BEL as a bell, even split across chunks', async () => {
    const { dispose } = await startWatcher()

    emit('\x1b]0;par')
    emit('tial title\x07')
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    dispose()
  })

  it('fires the prompt-cache timer and agent-task-complete on working→idle', async () => {
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    flushSideEffects()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
      PANE_KEY,
      expect.any(Number)
    )
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY
    })
    dispose()
  })

  it('suppresses the completion OS notification when only terminal attention is on', async () => {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: true,
      notifications: { enabled: true, agentTaskComplete: false }
    }
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY,
      suppressOsNotification: true
    })
    dispose()
  })

  it('skips completion dispatch when tracking is fully disabled, keeping the cache timer', async () => {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: false,
      notifications: { enabled: false }
    }
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
      PANE_KEY,
      expect.any(Number)
    )
    dispose()
  })

  it('lets a same-burst completion supersede the pending bell OS notification', async () => {
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    flushSideEffects()
    emit(`${IDLE_TITLE_OSC}\x07`)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 8)

    // The bell still marks unread immediately; only the OS notification yields.
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith(WORKTREE_ID)
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.objectContaining({ source: 'agent-task-complete' })
    )
    dispose()
  })

  it('cancels the pending completion and clears the cache timer when working resumes', async () => {
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    emit(WORKING_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)
    dispose()
  })

  it('answers a DECSET 2031 subscribe split across chunks via sendInput', async () => {
    const { dispose, sendInput } = await startWatcher()

    emit('\x1b[?20')
    expect(sendInput).not.toHaveBeenCalled()

    emit('31h')
    expect(sendInput).toHaveBeenCalledTimes(1)
    // theme=system + prefers-dark → dark reply per terminal-color-scheme-protocol.
    expect(sendInput).toHaveBeenCalledWith('\x1b[?997;1n')

    emit('\x1b[?2031l')
    expect(sendInput).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('stops answering DECSET 2031 after dispose', async () => {
    const { dispose, sendInput } = await startWatcher()

    dispose()
    emit('\x1b[?2031h')

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('observes GitHub PR links across chunk boundaries', async () => {
    const { dispose } = await startWatcher()

    emit('PR: https://github.com/orca-dev/orca/pull/42')
    expect(mockStoreState.observeTerminalGitHubPullRequestLink).not.toHaveBeenCalled()

    emit('1\r\ndone')
    expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledTimes(1)
    expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.objectContaining({
        url: 'https://github.com/orca-dev/orca/pull/421',
        number: 421,
        slug: { owner: 'orca-dev', repo: 'orca', host: 'github.com' }
      })
    )
    dispose()
  })

  it('fires completion when seeded with a working title and the agent goes idle while parked', async () => {
    // Why: the pane was working at park time; the watcher's fresh tracker
    // must be seeded or this working→idle transition can never fire.
    const { dispose } = await startWatcher({ initialTitle: '⠋ Build feature' })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY
    })
    dispose()
  })

  it('does not fire completion for an idle title without a seed or observed transition', async () => {
    const { dispose } = await startWatcher()

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    dispose()
  })

  it('clears the watcher-written runtime title slot on dispose', async () => {
    const { dispose } = await startWatcher()

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)

    dispose()
    expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID)
  })

  it('leaves the runtime title slot alone on dispose when it never wrote one', async () => {
    const { dispose } = await startWatcher()

    emit('plain output with no titles\r\n')
    flushSideEffects()

    dispose()
    expect(mockStoreState.clearRuntimePaneTitle).not.toHaveBeenCalled()
  })

  it('shutdown dispose cancels the armed completion timer and silences the final flush', async () => {
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()

    // Equivalent to shutdownWorktreeTerminals → disposeParkedTerminalWatchersForPtyIds.
    dispose()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    // The teardown flush that main emits after pty.kill must be a no-op.
    emit('final teardown flush\x07')
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
    expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('dispose unregisters the sidecar and cancels the pending bell notification', async () => {
    const { dispose } = await startWatcher()

    emit('\x07')
    flushSideEffects()
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledTimes(1)

    dispose()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    emit('\x07')
    flushSideEffects()
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledTimes(1)

    // Idempotent: a second dispose must not throw or clobber another watcher.
    dispose()
  })

  it('disposes the previous watcher when a new one starts for the same PTY', async () => {
    await startWatcher({ paneId: 1 })
    const second = await startWatcher({ paneId: 2 })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledTimes(1)
    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 2, IDLE_TITLE)
    second.dispose()
  })

  // ─── Main side-effect authority (terminal-side-effect-authority.md) ────
  //
  // With the kill switch on, the watcher must not register byte parsers —
  // main is the single byte parser and the watcher's policy block consumes
  // pty:sideEffect facts instead. The byte sidecar stays ONLY for the 2031
  // reply (query authority never moves to main); PR links arrive as facts.
  describe('with main side-effect authority on', () => {
    function enableMainAuthority(): void {
      mockStoreState.settings = {
        ...mockStoreState.settings,
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
      mockStoreState.setRuntimePaneTitle.mockImplementation((...args: unknown[]) => {
        calls.push(['setRuntimePaneTitle', ...args])
      })
      mockStoreState.updateTabTitle.mockImplementation((...args: unknown[]) => {
        calls.push(['updateTabTitle', ...args])
      })
      mockStoreState.markWorktreeUnread.mockImplementation((...args: unknown[]) => {
        calls.push(['markWorktreeUnread', ...args])
      })
      mockStoreState.markTerminalTabUnread.mockImplementation((...args: unknown[]) => {
        calls.push(['markTerminalTabUnread', ...args])
      })
      mockStoreState.markTerminalPaneUnread.mockImplementation((...args: unknown[]) => {
        calls.push(['markTerminalPaneUnread', ...args])
      })
      mockStoreState.setCacheTimerStartedAt.mockImplementation((key: unknown, at: unknown) => {
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
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
      expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
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
      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)
      expect(mockStoreState.updateTabTitle).toHaveBeenCalledWith(TAB_ID, IDLE_TITLE)
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
      expect(mockStoreState.setCacheTimerStartedAt).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('applies bell facts with the byte-mode policy: unread now, OS notification delayed', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([{ kind: 'bell' }])

      expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith(WORKTREE_ID)
      expect(mockStoreState.markTerminalTabUnread).toHaveBeenCalledWith(TAB_ID)
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()

      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
        source: 'terminal-bell',
        paneKey: PANE_KEY
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
      expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)

      await dispatchFacts([
        { kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE },
        { kind: 'agent-idle', title: IDLE_TITLE }
      ])
      expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
        PANE_KEY,
        expect.any(Number)
      )

      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
        source: 'agent-task-complete',
        terminalTitle: IDLE_TITLE,
        paneKey: PANE_KEY
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

      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenLastCalledWith(
        TAB_ID,
        PANE_ID,
        'Build feature'
      )
      expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
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
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
      expect(mockStoreState.setCacheTimerStartedAt).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('answers DECSET 2031 from the main 2031-subscribe fact, never the byte scan', async () => {
      // Why: with the hidden-delivery gate on (default), parked PTY bytes are
      // dropped in main — the fact is the only 2031 signal, and the byte
      // sidecar must NOT exist (its registration would re-enable delivery).
      enableMainAuthority()
      const { dispose, sendInput } = await startWatcher()

      emit('\x1b[?2031h')
      expect(sendInput).not.toHaveBeenCalled()

      await dispatchFacts([{ kind: '2031-subscribe' }])
      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith('\x1b[?997;1n')

      // Why: pr-link facts arrive on the channel; byte-scanning here too
      // would observe every link twice.
      emit('PR: https://github.com/orca-dev/orca/pull/42\r\n')
      expect(mockStoreState.observeTerminalGitHubPullRequestLink).not.toHaveBeenCalled()
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

    it('keeps the byte 2031 responder and no hidden bit when the gate kill switch is off', async () => {
      enableMainAuthority()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalHiddenDeliveryGate: false
      } as MockStoreState['settings']
      const setHiddenRendererPty = vi.fn()
      ;(
        window as unknown as { api: { pty: Record<string, unknown> } }
      ).api.pty.setHiddenRendererPty = setHiddenRendererPty
      const { dispose, sendInput } = await startWatcher()

      // Gate off — bytes keep flowing, so the split-chunk byte scan answers.
      emit('\x1b[?20')
      expect(sendInput).not.toHaveBeenCalled()
      emit('31h')
      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith('\x1b[?997;1n')

      // Why: a 2031-subscribe fact must not double-fire the reply in byte
      // mode — exactly one responder owns the answer at any time.
      await dispatchFacts([{ kind: '2031-subscribe' }])
      expect(sendInput).toHaveBeenCalledTimes(1)

      expect(setHiddenRendererPty).not.toHaveBeenCalled()
      dispose()
    })

    it('observes PR links from pr-link facts with worktree attribution', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      const link = {
        url: 'https://github.com/orca-dev/orca/pull/421',
        slug: { owner: 'orca-dev', repo: 'orca' },
        number: 421
      }
      await dispatchFacts([{ kind: 'pr-link', link }])

      expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledTimes(1)
      expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
        WORKTREE_ID,
        link
      )
      dispose()
    })

    it('dispose unregisters the fact consumer and clears a written title slot', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([{ kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE }])
      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)

      dispose()
      expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID)

      await dispatchFacts([{ kind: 'bell' }])
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
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
        vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
        dispose()
      }

      // Pass 2: fresh modules/store, authority on, facts derived by the
      // shared main tracker from the same bytes.
      vi.resetModules()
      mockStoreState = createMockStoreState()
      dispatchTerminalNotification.mockReset()
      const factModeCalls = recordPolicyOutcomes()
      {
        enableMainAuthority()
        const { dispose } = await startWatcher()
        await emitViaMainTrackerFacts(fixtureChunks)
        vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
        dispose()
      }

      expect(byteModeCalls.length).toBeGreaterThan(0)
      expect(factModeCalls).toEqual(byteModeCalls)
    })
  })
})
