import { registerParkedTerminalSourceTests } from './parked-terminal-source.spec'
import { registerParkedTerminalAuthorityTests } from './parked-terminal-authority.spec'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type { TerminalSemanticResident } from './terminal-semantic-residents'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './agent-task-complete-policy'
import type { TerminalSideEffectFact } from '../../../../shared/terminal-side-effect-facts'
import type { PtyDataMeta } from './pty-dispatcher'
import { TerminalSnapshotState } from '../../../../shared/terminal-snapshot-state'
import type { RuntimeTerminalDataSubscriptionOptions } from '@/runtime/runtime-terminal-stream'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'

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

export type MockStoreState = ReturnType<typeof createInitialStoreState> & {
  setRuntimePaneTitle: ReturnType<
    typeof vi.fn<(tabId: string, paneId: number, title: string) => void>
  >
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn<(tabId: string, title: string) => void>>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
}

export type ParkedWatcherTestInstance = {
  dispose: () => void
  ptyWrite: ReturnType<typeof vi.fn>
  getResident: () => TerminalSemanticResident | undefined
}

const dispatchTerminalNotification = vi.fn()
let mockStoreState: MockStoreState

const remoteNeedsSnapshots = vi.fn().mockResolvedValue(true)
let holdRemoteAdmission = false
const remoteSubscriptions: {
  data: (data: string, meta?: PtyDataMeta) => void
  options?: RuntimeTerminalDataSubscriptionOptions
  close: ReturnType<typeof vi.fn>
}[] = []
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcClient>()),
  runtimeEnvironmentSupportsCapability: remoteNeedsSnapshots
}))
vi.mock('@/runtime/runtime-terminal-stream', () => ({
  subscribeToRuntimeTerminalData: vi.fn(
    async (
      _ptyId: string,
      _clientId: string,
      data: (data: string, meta?: PtyDataMeta) => void,
      options?: RuntimeTerminalDataSubscriptionOptions
    ) => {
      const close = vi.fn()
      remoteSubscriptions.push({ data, options, close })
      if (!holdRemoteAdmission) {
        options?.onAdmitted?.()
      }
      return close
    }
  )
}))

vi.mock('./use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))

vi.mock('@/lib/terminal-theme', () => ({
  getSystemPrefersDark: () => true
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState, subscribe: vi.fn(() => () => {}) }
}))

function createMockStoreState(): MockStoreState {
  return {
    ...createInitialStoreState(() => mockStoreState),
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID, ptyId: PTY_ID }] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] },
    isPtyShutdownPending: () => false,
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
    setRuntimePaneTitle: vi.fn<(tabId: string, paneId: number, title: string) => void>(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabTitle: vi.fn<(tabId: string, title: string) => void>(),
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
  ): Promise<ParkedWatcherTestInstance> {
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
    const { getTerminalSemanticResident } = await import('./terminal-side-effect-facts-handler')
    return {
      dispose,
      ptyWrite,
      getResident: () => getTerminalSemanticResident(overrides.ptyId ?? PTY_ID)
    }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    onData = null
    remoteSubscriptions.length = 0
    holdRemoteAdmission = false
    remoteNeedsSnapshots.mockResolvedValue(true)
    mockStoreState = createMockStoreState()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The partial Window exposes actual parked PTY admission/inspection/data/replay/exit methods; these full watcher cases exercise that same producer without fabricating the rest of preload.
    globalThis.window = {
      ...originalWindow,
      api: {
        pty: {
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          ackData: vi.fn(),
          hasPty: vi.fn().mockResolvedValue(true),
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: null, hasChildProcesses: false }),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null),
          getForegroundProcess: vi.fn().mockResolvedValue(null),
          hasChildProcesses: vi.fn().mockResolvedValue(false)
        }
      }
    } as unknown as typeof window
  })

  afterEach(async () => {
    const handler = await import('./terminal-side-effect-facts-handler')
    handler._resetTerminalSideEffectFactConsumersForTest()
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  registerParkedTerminalSourceTests({
    getStore: () => mockStoreState,
    startWatcher,
    dispatchTerminalNotification,
    emit,
    getOnData: () => onData,
    holdRemoteAdmission: () => {
      holdRemoteAdmission = true
    },
    getRemoteSubscriptions: () => remoteSubscriptions
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

  it('does not drive the tab title when drivesTabTitle is false', async () => {
    const { dispose } = await startWatcher({ drivesTabTitle: false })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)
    expect(mockStoreState.updateTabTitle).not.toHaveBeenCalled()
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

    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

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
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)

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

    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY,
      ptyId: PTY_ID,
      workspaceOwner: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
    dispose()
  })

  it('forwards completion to notification policy when only terminal attention is on', async () => {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: true,
      notifications: { enabled: true, agentTaskComplete: false }
    }
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()
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

  it('keeps mobile completion detection active when desktop notifications and attention are off', async () => {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: false,
      notifications: { enabled: false }
    }
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.objectContaining({ source: 'agent-task-complete' })
    )
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
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)
    dispose()
  })

  // DECSET 2031 subscribes rather than queries; replying after fish withdraws paints the reply at the prompt (#9993).
  it('never writes a color-scheme reply for a DECSET 2031 subscribe', async () => {
    const { dispose, ptyWrite } = await startWatcher()

    emit('\x1b[?20')
    emit('31h')
    emit('\x1b[?2031l')

    expect(ptyWrite).not.toHaveBeenCalled()
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

  it('consumes first live capable companions and unattributed advances once on a zero-port execution', async () => {
    const handler = await import('./terminal-side-effect-facts-handler')
    const { TerminalSnapshotState } = await import('../../../../shared/terminal-snapshot-state')
    const watched = await startWatcher()
    const before = watched.getResident()
    watched.dispose()
    const source = new TerminalSnapshotState()
    source.record({ kind: 'bell' }, 10)
    const first = {
      ptyId: PTY_ID,
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      seq: 1,
      facts: [{ kind: 'bell' as const }],
      terminalState: {
        runtimeId: 'runtime',
        incarnationId: 'physical',
        snapshot: source.snapshot()
      }
    }
    handler.dispatchTerminalSideEffectBatch(first)
    const resident = handler.getTerminalSemanticResident(PTY_ID)
    if (!resident) {
      throw new Error('Qualified capable ingress must admit E')
    }
    expect(resident).toBe(before)
    const cursor = Object.getOwnPropertyDescriptor(resident, 'consumption')?.value
    const controllers = [
      resident.policy.completion,
      resident.policy.legacySource,
      resident.policy.input
    ]
    const captured = vi.fn(() => () => {})
    const detach = handler.registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      binding: resident.policy.binding,
      onResident: captured
    })
    expect(captured).toHaveBeenCalledExactlyOnceWith(resident)
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(1)
    source.record({ kind: 'bell' }, 20)
    const terminalState = {
      runtimeId: 'runtime',
      incarnationId: 'physical',
      snapshot: source.snapshot()
    }
    handler.dispatchTerminalSideEffectBatch({
      ptyId: PTY_ID,
      seq: 2,
      facts: [{ kind: 'bell' }],
      terminalState
    })
    handler.dispatchTerminalSideEffectBatch({ ...first, terminalState })
    handler.dispatchTerminalSideEffectBatch({ ...first, replay: true, terminalState })
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(2)
    source.record({ kind: 'bell' }, 30)
    handler.dispatchTerminalSideEffectBatch({
      ptyId: PTY_ID,
      seq: 3,
      facts: [{ kind: 'bell' }],
      terminalState: { ...terminalState, runtimeId: 'foreign', snapshot: source.snapshot() }
    })
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(2)
    expect(handler.getTerminalSemanticResident(PTY_ID)).toBe(resident)
    expect(Object.getOwnPropertyDescriptor(resident, 'consumption')?.value).toBe(cursor)
    expect([
      resident.policy.completion,
      resident.policy.legacySource,
      resident.policy.input
    ]).toEqual(controllers)
    const ended = vi.fn()
    resident.onEnd(ended)
    detach()
    expect(resident.isLive).toBe(true)
    expect(ended).not.toHaveBeenCalled()
    handler.retireTerminalSemanticResident(PTY_ID, 'foreign-incarnation')
    expect(ended).not.toHaveBeenCalled()
    handler.retireTerminalSemanticResident(PTY_ID, 'physical')
    expect(ended).toHaveBeenCalledExactlyOnceWith(resident)
  })

  it('keeps Escape history per writer while captured execution ACK groups reject an older turn', async () => {
    const { getResident, dispose } = await startWatcher()
    const resident = getResident()
    if (!resident) {
      throw new Error('Positive source must admit E')
    }
    const inferInterrupt = vi.fn().mockResolvedValue(true)
    Object.assign(window.api, { agentStatus: { inferInterrupt } })
    const row = {
      paneKey: PANE_KEY,
      state: 'working' as const,
      prompt: 'original',
      agentType: 'opencode' as const,
      updatedAt: Date.now(),
      stateStartedAt: Date.now() - 10,
      stateHistory: []
    }
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = row
    const input = resident.policy.input
    const first = input.createInterruptWriter()
    const second = input.createInterruptWriter()
    const group = input.reserveInterruptBaseline(row)
    expect(input.reserveInterruptBaseline(row)).toBe(group)
    first.observeInputIntent('plain-escape', row, group)
    second.observeInputIntent('plain-escape', row, group)
    await vi.advanceTimersByTimeAsync(100)
    expect(inferInterrupt).not.toHaveBeenCalled()
    const release = first.retain()
    first.release()
    dispose()
    expect(resident.isLive).toBe(true)
    await first.observeInputIntent('plain-escape', row, group)
    await vi.advanceTimersByTimeAsync(350)
    expect(inferInterrupt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ baselinePrompt: 'original', inputCount: 2 })
    )
    release()
    const newer = {
      ...row,
      prompt: 'new turn',
      updatedAt: Date.now(),
      stateStartedAt: Date.now() - 10
    }
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = newer
    const newerGroup = input.reserveInterruptBaseline(newer)
    expect(newerGroup).toBeGreaterThan(group)
    expect(input.reserveInterruptBaseline(row)).toBeLessThan(newerGroup)
    second.observeInputIntent('plain-escape', row, group)
    await vi.advanceTimersByTimeAsync(350)
    expect(inferInterrupt).toHaveBeenCalledTimes(1)
    second.release()
  })

  it('settles Command Code output after parking without replacing the policy', async () => {
    const { dispose, getResident } = await startWatcher()
    emit('# Command Code v0.27.2\r\n')
    emit('❯ Fix the spinner\r\n')
    emit('⌘ Parsing...')
    expect(mockStoreState.agentStatusByPaneKey[PANE_KEY]).toEqual(
      expect.objectContaining({
        state: 'working',
        prompt: 'Fix the spinner',
        agentType: 'command-code'
      })
    )
    const resident = getResident()
    emit('\r\n❯ Ask your question...\r\n')
    dispose()
    await vi.advanceTimersByTimeAsync(2000)
    expect(getResident()).toBe(resident)
    expect(mockStoreState.agentStatusByPaneKey[PANE_KEY]).toEqual(
      expect.objectContaining({
        state: 'done',
        prompt: 'Fix the spinner',
        agentType: 'command-code'
      })
    )
  })

  it('fires completion when seeded with a working title and the agent goes idle while parked', async () => {
    // Seed prior working state so the recreated tracker can recognize working→idle.
    const { dispose } = await startWatcher({ initialTitle: '⠋ Build feature' })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY,
      ptyId: PTY_ID,
      workspaceOwner: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
    dispose()
  })

  it('does not fire completion for an idle title without a seed or observed transition', async () => {
    const { dispose } = await startWatcher()

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)

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

    // A committed shutdown ends the execution; hiding only detaches its presentation.
    const handler = await import('./terminal-side-effect-facts-handler')
    handler.observeTerminalSemanticResidentExit(PTY_ID, 0)
    dispose()
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    // The teardown flush that main emits after pty.kill must be a no-op.
    emit('final teardown flush\x07')
    flushSideEffects()
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)
    expect(mockStoreState.markTerminalBell).not.toHaveBeenCalled()
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('execution retirement unregisters the sidecar and cancels the pending bell notification', async () => {
    const { dispose } = await startWatcher()

    emit('\x07')
    flushSideEffects()
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(1)

    const handler = await import('./terminal-side-effect-facts-handler')
    handler.observeTerminalSemanticResidentExit(PTY_ID, 0)
    dispose()
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    emit('\x07')
    flushSideEffects()
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(1)

    // Idempotent: a second dispose must not throw or clobber another watcher.
    dispose()
  })

  // Why: retained gauges would inflate every later high-water profile.
  it('disposes the previous watcher when a new one starts for the same PTY', async () => {
    await startWatcher({ paneId: 1 })
    const second = await startWatcher({ paneId: 2 })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledTimes(1)
    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 2, IDLE_TITLE)
    second.dispose()
  })

  it('consumes host facts during a supported paired output pause', async () => {
    const remotePtyId = 'remote:env-1@@terminal-1'
    const { dispose } = await startWatcher({ ptyId: remotePtyId })
    const handler = await import('./terminal-side-effect-facts-handler')

    expect(onData).toBeNull()
    handler._dispatchTerminalSideEffectBatchForTest({
      ptyId: remotePtyId,
      seq: 10,
      facts: [
        {
          kind: 'title',
          normalizedTitle: '⠋ Remote build',
          rawTitle: '⠋ Remote build'
        }
      ]
    })

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(
      TAB_ID,
      PANE_ID,
      '⠋ Remote build'
    )
    dispose()
  })

  it('retains legacy parsing and policy through pending discovery, pause, detach and host upgrade', async () => {
    let resolveCapability: (supported: boolean) => void = () => {}
    remoteNeedsSnapshots.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveCapability = resolve
      })
    )
    const ptyId = 'remote:env-1@@terminal-1'
    mockStoreState.tabsByWorktree[WORKTREE_ID][0].ptyId = ptyId
    mockStoreState.ptyIdsByTabId[TAB_ID] = [ptyId]
    const layout = mockStoreState.terminalLayoutsByTabId?.[TAB_ID]
    if (!layout?.ptyIdsByLeafId) {
      throw new Error('Expected the initialized terminal leaf map')
    }
    layout.ptyIdsByLeafId[LEAF_ID] = ptyId
    const { dispose, getResident } = await startWatcher({ ptyId })
    const resident = getResident()!
    const policy = resident.policy
    const source = policy.legacySource
    const handler = await import('./terminal-side-effect-facts-handler')
    const facts = (seq: number, items: TerminalSideEffectFact[]) =>
      handler.dispatchTerminalSideEffectBatch({ ptyId, seq, facts: items })
    let rawEndSeq = 0
    const raw = (data: string) => {
      rawEndSeq += data.length
      const meta = { seq: rawEndSeq, rawLength: data.length }
      if (remoteSubscriptions[0]) {
        remoteSubscriptions[0].data(data, meta)
      } else {
        policy.observeLegacyData(data, meta)
      }
    }

    // An unfinished raw prefix belongs to this execution, including while facts own attention.
    raw('output\x1b]133;')
    facts(rawEndSeq, [
      { kind: 'title', normalizedTitle: '⠋ Remote build', rawTitle: '⠋ Remote build' },
      { kind: 'agent-working' },
      { kind: 'bell' }
    ])
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(1)
    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(
      TAB_ID,
      PANE_ID,
      '⠋ Remote build'
    )
    dispose()
    resolveCapability(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(getResident()).toBe(resident)
    expect(resident.policy).toBe(policy)
    expect(policy.legacySource).toBe(source)
    expect(remoteSubscriptions).toHaveLength(1)
    raw('C\x07command output')
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(1)
    // Synthetic hook attention has no raw-stream copy on an old paired host.
    facts(rawEndSeq, [{ kind: 'bell' }])
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(2)
    // Old raw-only output and synthetic facts both retain their supported delivery.
    raw('ordinary bell\x07')
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(3)
    raw('\x1b]133;D;7\x07')

    const host = new TerminalSnapshotState()
    host.record({ kind: 'bell' })
    host.record({ kind: 'title', rawTitle: '⠋ Remote build', normalizedTitle: '⠋ Remote build' })
    const publish = () =>
      handler.dispatchTerminalSideEffectBatch({
        ptyId,
        seq: rawEndSeq,
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        facts: [],
        terminalState: {
          runtimeId: 'host-runtime',
          incarnationId: 'host-incarnation',
          snapshot: host.snapshot()
        }
      })
    publish()
    expect(getResident()).toBe(resident)
    expect(resident.policy).toBe(policy)
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(3)
    expect(remoteSubscriptions[0].close).toHaveBeenCalledOnce()
    host.record({ kind: 'bell' })
    publish()
    publish()
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(4)
    // A delayed old-reader callback cannot apply after host snapshot admission.
    raw('stale bell\x07')
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledTimes(4)
  })

  it('preserves a real resident on shutdown rollback and retires only its captured execution on commit', async () => {
    const { getResident } = await startWatcher()
    const resident = getResident()!
    emit(WORKING_TITLE_OSC)
    const shutdown = await import('./pty-shutdown-data-suspension')
    const [rollback] = shutdown.unregisterPtyDataHandlers([PTY_ID])
    rollback.rollback()
    expect(getResident()).toBe(resident)
    emit(IDLE_TITLE_OSC)
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(dispatchTerminalNotification).toHaveBeenCalledOnce()
    const [commit] = shutdown.unregisterPtyDataHandlers([PTY_ID])
    const handler = await import('./terminal-side-effect-facts-handler')
    handler.retireTerminalSemanticResident(PTY_ID)
    const replacement = handler.admitLegacyTerminalSemanticResident({
      ptyId: PTY_ID,
      incarnationId: 'replacement',
      binding: resident.policy.binding,
      byteSource: true
    })
    commit.commit()
    expect(resident.isLive).toBe(false)
    expect(getResident()).toBe(replacement)
    expect(replacement.isLive).toBe(true)
    emit('bell\x07')
    expect(mockStoreState.markTerminalBell).toHaveBeenCalledOnce()
  })

  it('keeps an older paired host reader across detach and reconnect until proven exit', async () => {
    remoteNeedsSnapshots.mockResolvedValue(false)
    const remotePtyId = 'remote:env-1@@terminal-1'
    const { dispose, getResident } = await startWatcher({ ptyId: remotePtyId })
    await vi.advanceTimersByTimeAsync(0)
    expect(remoteSubscriptions).toHaveLength(1)
    expect(remoteSubscriptions[0].options?.startAtLiveTail).toBe(true)
    const resident = getResident()
    expect(resident?.identity.incarnationId).toBeNull()
    remoteSubscriptions[0].data(WORKING_TITLE_OSC)
    dispose()
    remoteSubscriptions[0].options?.onTransportClose?.({ recoverable: true })
    await vi.advanceTimersByTimeAsync(250)
    expect(remoteSubscriptions).toHaveLength(2)
    expect(getResident()).toBe(resident)
    remoteSubscriptions[1].data(IDLE_TITLE_OSC)
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.objectContaining({ source: 'agent-task-complete', ptyId: remotePtyId })
    )
    remoteSubscriptions[1].options?.onEnd?.('unverifiable')
    expect(resident?.isLive).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(remoteSubscriptions).toHaveLength(3)
    remoteSubscriptions[2].options?.onEnd?.('exited')
    expect(resident?.isLive).toBe(false)
    expect(getResident()).toBeUndefined()
  })

  // ─── Main side-effect authority (terminal-side-effect-authority.md) ────
  //
  // With the kill switch on, the watcher must not register byte parsers —
  // main is the single byte parser and the watcher's policy block consumes
  // pty:sideEffect facts instead; PR links arrive as facts.
  registerParkedTerminalAuthorityTests({
    getStore: () => mockStoreState,
    resetStore: () => {
      mockStoreState = createMockStoreState()
    },
    dispatchTerminalNotification,
    startWatcher,
    emit,
    flushSideEffects
  })
})
