import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectFact } from '../../../../../../shared/terminal/output/terminal-side-effect-facts'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import type * as ParkedTerminalCommandStatus from './parked-terminal-command-status'

const PTY_ID = 'pty-parked-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PANE_ID = 1
// Mirrors PARKED_NOTIFICATION_GRACE_MS / AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS.
const NOTIFICATION_GRACE_MS = 250

// Real titles classify braille spinners as working and Claude’s ✳ prefix as idle.
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
  markTerminalBell: ReturnType<typeof vi.fn>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  agentStatusByPaneKey: Record<string, { state: string; prompt: string; agentType?: string }>
  paneForegroundAgentByPaneKey: Record<string, { agent: string | null }>
}

const dispatchTerminalNotification = vi.fn()
let mockStoreState: MockStoreState

vi.mock('../../notifications/dispatch-terminal-notification', () => ({
  dispatchTerminalNotification
}))

// Command-status semantics live in their own suite; verify watcher-to-policy wiring here.
const commandStatusPolicy = {
  onCommandFinished: vi.fn(),
  onCommandCodeWorking: vi.fn(),
  onCommandCodeDone: vi.fn(),
  dispose: vi.fn()
}
// Partial mock: readInFlightCommandCodeTurn stays real so detector seeding reads the store.
vi.mock('./parked-terminal-command-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ParkedTerminalCommandStatus>()),
  createParkedTerminalCommandStatusPolicy: vi.fn(() => commandStatusPolicy)
}))

vi.mock('@/lib/terminal-theme', () => ({
  getSystemPrefersDark: () => true
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mockStoreState } }))

function createMockStoreState(): MockStoreState {
  return {
    // Pin legacy byte mode here; dedicated cases below cover main-authority facts.
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
    markTerminalBell: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    observeTerminalGitHubPullRequestLink: vi.fn(),
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {}
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
  ): Promise<{ dispose: () => void; ptyWrite: ReturnType<typeof vi.fn> }> {
    const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
    const ptyWrite = vi.fn()
    ;(window as unknown as { api: { pty: Record<string, unknown> } }).api.pty.write = ptyWrite
    const dispose = startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID,
      ...overrides
    })
    return { dispose, ptyWrite }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    commandStatusPolicy.onCommandFinished.mockClear()
    commandStatusPolicy.onCommandCodeWorking.mockClear()
    commandStatusPolicy.onCommandCodeDone.mockClear()
    commandStatusPolicy.dispose.mockClear()
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

  // Publish hookless Cursor identity once; redraws must not overwrite its synthesized status title (#10258).
  it('stores the bare cursor-agent native title once, then keeps the synthetic title', async () => {
    const { dispose } = await startWatcher()

    emit('\x1b]0;Cursor Agent\x07')
    emit('\x1b]0;Cursor Agent\x07')
    emit('\x1b]0;⠋ Cursor Agent\x07')
    emit('\x1b]0;Cursor Agent\x07')
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle.mock.calls).toEqual([
      [TAB_ID, PANE_ID, 'Cursor Agent'],
      [TAB_ID, PANE_ID, '⠋ Cursor Agent']
    ])
    expect(mockStoreState.updateTabTitle.mock.calls).toEqual([
      [TAB_ID, 'Cursor Agent'],
      [TAB_ID, '⠋ Cursor Agent']
    ])
    dispose()
  })

  it('marks unread on BEL and schedules the delayed terminal-bell OS notification', async () => {
    const workspaceOwner = { executionHostId: 'ssh:qa' as const, runtimeEnvironmentId: 'hub' }
    const { dispose } = await startWatcher({ workspaceOwner })

    emit('build finished\x07')
    flushSideEffects()

    expect(mockStoreState.markTerminalBell).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      paneKey: PANE_KEY
    })
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'terminal-bell',
      paneKey: PANE_KEY,
      ptyId: PTY_ID,
      workspaceOwner
    })
    dispose()
  })

  it('does not treat an OSC-terminator BEL as a bell, even split across chunks', async () => {
    const { dispose } = await startWatcher()

    emit('\x1b]0;par')
    emit('tial title\x07')
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(mockStoreState.markTerminalBell).not.toHaveBeenCalled()
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
      paneKey: PANE_KEY,
      ptyId: PTY_ID
    })
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
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      paneKey: PANE_KEY
    })
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
      }),
      expect.objectContaining({ tabId: TAB_ID, ptyId: PTY_ID })
    )
    dispose()
  })

  it('feeds a Command Code return to the idle composer through as done', async () => {
    const { dispose } = await startWatcher()

    emit('# Command Code v0.27.2\r\n')
    emit('❯ Fix the spinner\r\n')
    emit('\r\n❯ Ask your question...\r\n')

    expect(commandStatusPolicy.onCommandCodeDone).toHaveBeenCalledWith('Fix the spinner')
    dispose()
  })

  it('arms the Command Code scrape from a turn already in flight at park time', async () => {
    // The banner is gone by park time; the live row must seed Command Code identity.
    mockStoreState.agentStatusByPaneKey = {
      [PANE_KEY]: { state: 'working', prompt: 'Fix the spinner', agentType: 'command-code' }
    }
    const { dispose } = await startWatcher()

    emit('\r\n❯ Ask your question...\r\n')

    expect(commandStatusPolicy.onCommandCodeDone).toHaveBeenCalledWith('Fix the spinner')
    dispose()
  })

  it('fires completion when seeded with a working title and the agent goes idle while parked', async () => {
    // Seed prior working state so the recreated tracker can recognize working→idle.
    const { dispose } = await startWatcher({ initialTitle: '⠋ Build feature' })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY,
      ptyId: PTY_ID
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
    expect(mockStoreState.markTerminalBell).not.toHaveBeenCalled()
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('dispose unregisters the sidecar and cancels the pending bell notification', async () => {
    const { dispose } = await startWatcher()

    emit('\x07')
    flushSideEffects()
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(1)

    dispose()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    emit('\x07')
    flushSideEffects()
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(1)

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

  // Main-authority mode parses bytes once in main; parked policy consumes derived facts, including PR links.
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
      const handler = await import('../../pty-transport/output/terminal-side-effect-facts-handler')
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: PTY_ID,
        seq: options.seq ?? 0,
        ...(options.replay ? { replay: true } : {}),
        facts
      })
    }

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
      expect(mockStoreState.markTerminalBell).not.toHaveBeenCalled()
      expect(mockStoreState.setCacheTimerStartedAt).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('clears state without completion attention for stale-derived idle facts', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([
        { kind: 'title', normalizedTitle: '⠋ Build feature', rawTitle: '⠋ Build feature' },
        { kind: 'agent-working' }
      ])
      // Stale-title expiry clears caches without granting completion to a merely paused agent.
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
      expect(mockStoreState.markTerminalBell).not.toHaveBeenCalled()
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
      expect(mockStoreState.markTerminalBell).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    })
  })
})
