import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalSideEffectFact } from '../../../../../../shared/terminal/output/terminal-side-effect-facts'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import type * as CacheTimerSeeding from '../../titles/cache-timer-seeding'
import { mockPanePtyArgs } from '@/components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-connect-mock-pane'

// The fixture layout binds LEAF_1 to this PTY, so the pane reattaches to it.
const PTY_ID = 'tab-pty'
const PANE_KEY = makePaneKey('tab-1', LEAF_1)

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []
let realSeeding: typeof CacheTimerSeeding

beforeAll(async () => {
  realSeeding = await vi.importActual<typeof CacheTimerSeeding>('../../titles/cache-timer-seeding')
})

describe('prompt cache countdown follows the agent session', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    mockStoreState.settings = { ...mockStoreState.settings, terminalMainSideEffectAuthority: true }
    bindPtyConnectionTestMocks({
      getState: () => mockStoreState,
      getTransportQueue: () => transportFactoryQueue,
      getTransportOptions: () => createdTransportOptions,
      getStoreSubscribers: () => storeSubscribers,
      setStoreSubscribers: (subscribers) => {
        storeSubscribers = subscribers
      }
    })
    await installTerminalTestGlobals()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await restoreTerminalTestGlobals()
  })

  let typeIntoPane: (data: string) => void = () => {}

  async function connectClaudePane(): Promise<(...facts: TerminalSideEffectFact[]) => void> {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
    const handler = await import('../../pty-transport/output/terminal-side-effect-facts-handler')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')
    transportFactoryQueue.push(createMockTransport())
    const deps = buildPaneConnectionDeps(() => mockStoreState)
    const pane = createPane(1)
    typeIntoPane = (data) => {
      for (const [listener] of pane.terminal.onData.mock.calls) {
        listener(data)
      }
    }
    connectPanePty(
      ...mockPanePtyArgs(pane, createManager(1), bindPaneAgentTitleMocks(deps, agentTitleMocks))
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.paneForegroundAgentByPaneKey[PANE_KEY] = {
      agent: 'claude',
      shellForeground: false
    }
    let seq = 0
    return (...facts) => {
      seq += 1
      handler._dispatchTerminalSideEffectBatchForTest({ ptyId: PTY_ID, seq, facts })
    }
  }

  async function exitToShell(dispatch: (...facts: TerminalSideEffectFact[]) => void) {
    dispatch(
      { kind: 'title', normalizedTitle: '', rawTitle: '' },
      { kind: 'command-finished', exitCode: 0 }
    )
    // Settle read only (FOREGROUND_COMMAND_READS.settleMs); the shell answers on the first read.
    await vi.advanceTimersByTimeAsync(400)
    await flushAsyncTicks()
  }

  const claudeIdle: TerminalSideEffectFact = {
    kind: 'agent-idle',
    title: '✳ Claude Code',
    status: 'idle'
  }

  it('does not count down for a relaunched Claude that has sent no request', async () => {
    const dispatch = await connectClaudePane()
    dispatch({ kind: 'agent-working' })
    await exitToShell(dispatch)

    dispatch(
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' },
      claudeIdle
    )

    expect(mockStoreState.cacheTimerByKey).not.toHaveProperty(PANE_KEY)
  })

  it('does not count down for a Claude relaunched before the shell read confirms the exit', async () => {
    const dispatch = await connectClaudePane()
    dispatch({ kind: 'agent-working' })
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('claude')

    dispatch(
      { kind: 'title', normalizedTitle: '', rawTitle: '' },
      { kind: 'command-finished', exitCode: 0 }
    )
    dispatch(
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' },
      claudeIdle
    )
    await vi.advanceTimersByTimeAsync(400)
    await flushAsyncTicks()

    expect(mockStoreState.cacheTimerByKey).not.toHaveProperty(PANE_KEY)
  })

  it('counts down when Claude goes idle while a leaked command-finished awaits its read', async () => {
    const dispatch = await connectClaudePane()
    dispatch(
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' },
      { kind: 'agent-working' }
    )
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('claude')

    dispatch({ kind: 'command-finished', exitCode: 0 }, claudeIdle)
    await vi.advanceTimersByTimeAsync(400)
    await flushAsyncTicks()

    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toEqual(expect.any(Number))
  })

  it('keeps the countdown through a leaked command-finished whose read never names Claude', async () => {
    const dispatch = await connectClaudePane()
    dispatch(
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' },
      { kind: 'agent-working' }
    )
    // An unrecognized foreground process (e.g. a Windows wrapper) leaves the read inconclusive.
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('vim')

    dispatch({ kind: 'command-finished', exitCode: 0 })
    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toBe('requested')
    dispatch(claudeIdle)
    await vi.advanceTimersByTimeAsync(5_000)
    await flushAsyncTicks()

    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toEqual(expect.any(Number))
  })

  it('does not restore a killed session for a Claude typed before the shell read', async () => {
    const dispatch = await connectClaudePane()
    dispatch(
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' },
      { kind: 'agent-working' }
    )
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('claude')

    dispatch(
      { kind: 'command-finished', exitCode: 137 },
      { kind: 'title', normalizedTitle: '', rawTitle: '' }
    )
    typeIntoPane('claude\r')
    await vi.advanceTimersByTimeAsync(400)
    await flushAsyncTicks()

    expect(mockStoreState.cacheTimerByKey).not.toHaveProperty(PANE_KEY)
  })

  it('does not restore a held session for a Claude relaunched through an alias before the read', async () => {
    const dispatch = await connectClaudePane()
    dispatch(
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' },
      { kind: 'agent-working' }
    )
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('claude')

    dispatch(
      { kind: 'command-finished', exitCode: 0 },
      { kind: 'title', normalizedTitle: '', rawTitle: '' },
      { kind: 'agent-exited' },
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' }
    )
    await vi.advanceTimersByTimeAsync(400)
    await flushAsyncTicks()

    expect(mockStoreState.cacheTimerByKey).not.toHaveProperty(PANE_KEY)
  })

  it('keeps the countdown through a leaked command-finished before any title is seen', async () => {
    const dispatch = await connectClaudePane()
    dispatch({ kind: 'agent-working' }, claudeIdle)
    const startedAt = mockStoreState.cacheTimerByKey[PANE_KEY]
    expect(startedAt).toEqual(expect.any(Number))
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('claude')

    dispatch({ kind: 'command-finished', exitCode: 0 })
    await vi.advanceTimersByTimeAsync(400)
    await flushAsyncTicks()

    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toBe(startedAt)
  })

  // Background shells fold to monitoring; a working background subagent folds to plain working.
  const claudeRow = (
    mainAgentState: 'working' | 'done',
    hold: 'monitoring' | 'agent-work' = 'monitoring'
  ): AgentStatusEntry => ({
    state: 'working',
    workingMode: mainAgentState === 'done' && hold === 'monitoring' ? 'monitoring' : undefined,
    mainAgent: { state: mainAgentState, stateStartedAt: Date.now() },
    prompt: 'run sleep 600 in the background',
    agentType: 'claude',
    paneKey: PANE_KEY,
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: []
  })

  it.each([
    ['background shells', 'monitoring' as const],
    ['a background subagent', 'agent-work' as const]
  ])('counts down once the turn ends while %s hold the row working', async (_label, hold) => {
    const dispatch = await connectClaudePane()
    dispatch({ kind: 'agent-working' })
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = claudeRow('done', hold)

    dispatch(claudeIdle)

    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toEqual(expect.any(Number))
  })

  it('counts down when the monitoring row lands after the idle title', async () => {
    const dispatch = await connectClaudePane()
    const { dispatchAgentHookTerminalLifecycle } =
      await import('../../agent-completion/agent-hook-terminal-lifecycle')
    dispatch({ kind: 'agent-working' })
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = claudeRow('working')
    dispatch(claudeIdle)
    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toBe('requested')

    mockStoreState.agentStatusByPaneKey[PANE_KEY] = claudeRow('done')
    dispatchAgentHookTerminalLifecycle(PANE_KEY, claudeRow('done'))

    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toEqual(expect.any(Number))
  })

  it('counts down when a background subagent waits for input after the idle title', async () => {
    const dispatch = await connectClaudePane()
    const { dispatchAgentHookTerminalLifecycle } =
      await import('../../agent-completion/agent-hook-terminal-lifecycle')
    dispatch({ kind: 'agent-working' })
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = claudeRow('working', 'agent-work')
    dispatch(claudeIdle)
    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toBe('requested')

    const waitingRow: AgentStatusEntry = { ...claudeRow('done', 'agent-work'), state: 'waiting' }
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = waitingRow
    dispatchAgentHookTerminalLifecycle(PANE_KEY, waitingRow)

    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toEqual(expect.any(Number))
  })

  it('ends a running countdown when Claude exits without resetting the title', async () => {
    const dispatch = await connectClaudePane()
    dispatch({ kind: 'agent-working' })
    dispatch(claudeIdle)
    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toEqual(expect.any(Number))

    await exitToShell(dispatch)

    expect(mockStoreState.cacheTimerByKey).not.toHaveProperty(PANE_KEY)
  })

  it('keeps a running countdown when the hook done applies the held monitoring idle title', async () => {
    const dispatch = await connectClaudePane()
    const { dispatchAgentHookTerminalLifecycle } =
      await import('../../agent-completion/agent-hook-terminal-lifecycle')
    dispatch({ kind: 'agent-working' })
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = claudeRow('done')
    dispatch(claudeIdle)
    const startedAt = mockStoreState.cacheTimerByKey[PANE_KEY]
    expect(startedAt).toEqual(expect.any(Number))

    await vi.advanceTimersByTimeAsync(60_000)
    const doneRow: AgentStatusEntry = {
      ...claudeRow('done'),
      state: 'done',
      workingMode: undefined
    }
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = doneRow
    dispatchAgentHookTerminalLifecycle(PANE_KEY, doneRow)

    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toBe(startedAt)
  })

  it('restores request evidence for a reattached working Claude titled with bare task text', async () => {
    const { shouldSeedCacheTimerOnInitialTitle } = await import('../../titles/cache-timer-seeding')
    vi.mocked(shouldSeedCacheTimerOnInitialTitle).mockImplementation(
      realSeeding.shouldSeedCacheTimerOnInitialTitle
    )
    onTestFinished(() => {
      vi.mocked(shouldSeedCacheTimerOnInitialTitle).mockReset()
    })
    Object.assign(mockStoreState, { subscribeAgentStatusChanges: () => () => {} })
    const dispatch = await connectClaudePane()
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = claudeRow('working')
    // The reattach's visible-pane read settled without an answer before the title arrived.
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('claude')

    dispatch({ kind: 'title', normalizedTitle: 'Ping localhost', rawTitle: 'Ping localhost' })
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()

    expect(mockStoreState.cacheTimerByKey[PANE_KEY]).toBe('requested')
  })

  it('does not restore an exited session for a Claude relaunched in the reattached pane', async () => {
    const { shouldSeedCacheTimerOnInitialTitle } = await import('../../titles/cache-timer-seeding')
    vi.mocked(shouldSeedCacheTimerOnInitialTitle).mockImplementation(
      realSeeding.shouldSeedCacheTimerOnInitialTitle
    )
    onTestFinished(() => {
      vi.mocked(shouldSeedCacheTimerOnInitialTitle).mockReset()
    })
    Object.assign(mockStoreState, { subscribeAgentStatusChanges: () => () => {} })
    const dispatch = await connectClaudePane()
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = {
      ...claudeRow('done'),
      state: 'done',
      workingMode: undefined,
      turnEndedAt: Date.now() - 60_000
    }
    mockStoreState.paneForegroundAgentByPaneKey[PANE_KEY] = { agent: null, shellForeground: false }
    dispatch({ kind: 'title', normalizedTitle: '', rawTitle: '' })

    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('claude')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('claude')
    typeIntoPane('claude\r')
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()
    dispatch(
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' },
      claudeIdle
    )

    expect(mockStoreState.cacheTimerByKey).not.toHaveProperty(PANE_KEY)
  })
})
