import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStallObservation } from '../../../shared/agent-stall-recovery-policy'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const PANE_A = `tab-a:${LEAF_A}`
const PANE_B = `tab-b:${LEAF_B}`
const NOW = 1_700_000_000_000

type RecoveryTestState = {
  agentStallByPaneKey: Record<string, AgentStallObservation>
  agentStallRecoveryLedgerByPaneKey: Record<
    string,
    { cause: 'auth' | 'network'; attempts: number; lastAttemptAt: number }
  >
  tabsByWorktree: Record<string, { id: string }[]>
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string | undefined> }>
  agentStatusByPaneKey: Record<string, never>
  recordAgentStallRecoveryAttempt: (paneKey: string, attempt: unknown) => void
  clearAgentStallObservations: (paneKeys: readonly string[]) => void
}

const testState = vi.hoisted(() => ({
  appState: null as unknown as RecoveryTestState,
  attempts: [] as { paneKey: string; attempt: unknown }[],
  cleared: [] as string[],
  sendNotes: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: RecoveryTestState) => unknown) => selector(testState.appState),
    { getState: () => testState.appState }
  )
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  sendNotesToActiveAgentSession: testState.sendNotes
}))

const { buildStalledAgentContinuePrompt, recoverStalledAgentPanes } =
  await import('./recover-stalled-agent-panes')

function observation(paneKey: string, overrides: Partial<AgentStallObservation> = {}) {
  return {
    paneKey,
    cause: 'network' as const,
    signature: 'Connection error',
    observedAt: NOW - 120_000,
    ...overrides
  }
}

function createState(): RecoveryTestState {
  return {
    agentStallByPaneKey: {},
    agentStallRecoveryLedgerByPaneKey: {},
    tabsByWorktree: { 'wt-1': [{ id: 'tab-a' }], 'wt-2': [{ id: 'tab-b' }] },
    terminalLayoutsByTabId: {
      'tab-a': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } },
      'tab-b': { ptyIdsByLeafId: { [LEAF_B]: 'pty-b' } }
    },
    agentStatusByPaneKey: {},
    recordAgentStallRecoveryAttempt: (paneKey, attempt) => {
      testState.attempts.push({ paneKey, attempt })
    },
    clearAgentStallObservations: (paneKeys) => {
      testState.cleared.push(...paneKeys)
      for (const paneKey of paneKeys) {
        delete testState.appState.agentStallByPaneKey[paneKey]
      }
    }
  }
}

// Regression (observed live): the continue prompt named the failure cause, the
// pane echoed Orca's paste as ordinary output, and the classifier re-detected it
// as a fresh auth stall — overwriting the real signature and feeding itself.
describe('buildStalledAgentContinuePrompt', () => {
  it('contains nothing the stall classifier reacts to', async () => {
    const { classifyAgentStallLine } = await import('../../../shared/agent-stall-signature')

    for (const cause of ['auth', 'network', 'rate-limit'] as const) {
      const prompt = buildStalledAgentContinuePrompt(cause)
      expect(prompt.length).toBeGreaterThan(0)
      // Whole prompt, and every line of it after any terminal re-wrapping.
      expect(classifyAgentStallLine(prompt), prompt).toBeNull()
      for (const line of prompt.split(/(?<=\.)\s+/)) {
        expect(classifyAgentStallLine(line), line).toBeNull()
      }
    }
  })
})

describe('recoverStalledAgentPanes', () => {
  beforeEach(() => {
    testState.appState = createState()
    testState.attempts = []
    testState.cleared = []
    testState.sendNotes.mockReset()
    testState.sendNotes.mockResolvedValue({ status: 'sent' })
  })

  it('continues every stalled pane in the fleet and clears the ones it recovered', async () => {
    testState.appState.agentStallByPaneKey = {
      [PANE_A]: observation(PANE_A, { observedAt: NOW - 200_000 }),
      [PANE_B]: observation(PANE_B, { cause: 'auth', signature: 'Invalid API key' })
    }

    const outcomes = await recoverStalledAgentPanes({ now: NOW })

    expect(outcomes.map((outcome) => [outcome.paneKey, outcome.status])).toEqual([
      [PANE_A, 'continued'],
      [PANE_B, 'continued']
    ])
    expect(testState.cleared).toEqual([PANE_A, PANE_B])
    expect(testState.sendNotes.mock.calls.map(([args]) => args.worktreeId)).toEqual([
      'wt-1',
      'wt-2'
    ])
    expect(testState.sendNotes.mock.calls[1][0].prompt).toBe(
      buildStalledAgentContinuePrompt('auth')
    )
  })

  it('records the attempt before sending, so a throwing send still costs the budget', async () => {
    testState.appState.agentStallByPaneKey = { [PANE_A]: observation(PANE_A) }
    testState.sendNotes.mockRejectedValue(new Error('runtime is gone'))

    const outcomes = await recoverStalledAgentPanes({ now: NOW })

    expect(testState.attempts).toEqual([
      {
        paneKey: PANE_A,
        attempt: { cause: 'network', observedAt: NOW - 120_000, attemptedAt: NOW }
      }
    ])
    expect(outcomes[0].status).toBe('failed')
    expect(testState.cleared).toEqual([])
  })

  it('honours the backoff fence unless the user forces recovery', async () => {
    testState.appState.agentStallByPaneKey = { [PANE_A]: observation(PANE_A) }
    testState.appState.agentStallRecoveryLedgerByPaneKey = {
      [PANE_A]: { cause: 'network', attempts: 3, lastAttemptAt: NOW - 1_000 }
    }

    expect(await recoverStalledAgentPanes({ now: NOW })).toEqual([])
    expect(testState.sendNotes).not.toHaveBeenCalled()

    const forced = await recoverStalledAgentPanes({ now: NOW, force: true })

    expect(forced.map((outcome) => outcome.status)).toEqual(['continued'])
  })

  it('forgets an observation whose pane no longer exists', async () => {
    const ghost = `tab-gone:${LEAF_A}`
    testState.appState.agentStallByPaneKey = {
      [ghost]: observation(ghost),
      [PANE_A]: observation(PANE_A)
    }

    const outcomes = await recoverStalledAgentPanes({ now: NOW })

    expect(testState.cleared).toEqual([ghost, PANE_A])
    expect(outcomes.map((outcome) => outcome.paneKey)).toEqual([PANE_A])
  })

  it('does nothing when no pane is stalled', async () => {
    expect(await recoverStalledAgentPanes({ now: NOW })).toEqual([])
    expect(testState.sendNotes).not.toHaveBeenCalled()
  })
})
