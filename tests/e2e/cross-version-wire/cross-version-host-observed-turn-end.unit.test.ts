import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import { projectStructuredAgentSessionStatusSummary } from '../../../src/shared/structured-agent-session-projection'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'

/**
 * A new host publishes what it observed of a turn's end when the provider gave no verdict:
 * `interruption` for a crash that cut the turn off, `unconfirmed` for an end it cannot prove. No
 * wire field is new, but the arms are, so every reader an older desktop runs on them must keep the
 * row and read the done it always did (Rule 3 and Rule 4 of the remote wire rules).
 *
 * The older build is pinned to the newest release whose status parser knew `mainAgent.outcome`,
 * so each reader here is one that validates the arm rather than one that never looks at it.
 */
const OLD_REF = 'v1.4.214'
const SUITE_TIMEOUT_MS = 180_000
// `superseded` is also journaled: a newer request replaced the turn, recorded at the replacement.
const NEW_ARMS = ['interruption', 'unconfirmed', 'superseded'] as const

type ParsedStatus = { state: string; interrupted?: boolean; mainAgent?: Record<string, unknown> }
type OldBuild = {
  normalizeAgentStatusPayload: (payload: unknown) => ParsedStatus | null
  structuredAgentSessionAgentStatus: (summary: Record<string, unknown>) => {
    state: string
    mainAgent: { state: string; outcome?: string }
  }
  mainAgentTurnInterrupted: (record: { outcome?: string } | undefined) => boolean
  sleepingAgentSessionsByPaneKeySchema: {
    safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> }
  }
  isAdmissibleAgentJournalRenderItem: (value: unknown) => boolean
  readAgentJournalTurnOutcome: (turn: { outcome?: string } | null | undefined) => string | null
}

let old: OldBuild

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(OLD_REF)
  const [types, agentStatus, fold, sleeping, journalSchemas, turnRecord] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/shared/agent-status-types.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/structured-agent-session-agent-status.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/agent-lead-status-fold.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/workspace-session-sleeping-agents.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/agent-session-journal-schemas.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/agent-session-turn-record.ts')
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release exports each member read below by these names; a missing one fails the test.
  old = {
    ...types,
    ...agentStatus,
    ...fold,
    ...sleeping,
    ...journalSchemas,
    ...turnRecord
  } as unknown as OldBuild
}, SUITE_TIMEOUT_MS)

/** A settled turn row this build journals when a newer request replaces the turn. */
const SUPERSEDED_TURN = {
  kind: 'turn',
  turnId: 'turn-1',
  state: 'interrupted',
  outcome: 'superseded',
  startedAt: 1,
  completedAt: 2
} as const

/** The summary this build's host projects for a turn it settled with no provider verdict. */
function newHostSummary(
  state: 'interrupted' | 'unverifiable',
  turn: Record<string, unknown> = { kind: 'turn', turnId: 'turn-1', state }
) {
  const items: AgentJournalRenderItem[] = [
    {
      itemId: 'u1',
      sequence: 1,
      revision: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
    },
    {
      itemId: 't1',
      sequence: 2,
      revision: 1,
      observedAt: 2,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a turn body built from the literal fields above, which this build's journal type admits.
      body: turn as AgentJournalRenderItem['body']
    }
  ]
  return JSON.parse(JSON.stringify(projectStructuredAgentSessionStatusSummary(items)))
}

describe('an older desktop reading a host-observed turn end', () => {
  it('receives the new arms from this host', () => {
    expect(newHostSummary('interrupted').turnOutcome).toBe('interruption')
    expect(newHostSummary('unverifiable').turnOutcome).toBe('unconfirmed')
    expect(newHostSummary('interrupted', SUPERSEDED_TURN).turnOutcome).toBe('superseded')
  })

  it('builds a structured row from the summary that reads done, never as a user stop', () => {
    for (const summary of [
      newHostSummary('interrupted'),
      newHostSummary('unverifiable'),
      newHostSummary('interrupted', SUPERSEDED_TURN)
    ]) {
      const agentStatus = old.structuredAgentSessionAgentStatus(summary)
      expect(agentStatus.state, summary.turnOutcome).toBe('done')
      expect(old.mainAgentTurnInterrupted(agentStatus.mainAgent), summary.turnOutcome).toBe(false)
    }
  })

  it('keeps a journaled superseded turn and reads its verdict as unknown', () => {
    const row = {
      itemId: 't1',
      sequence: 2,
      revision: 1,
      observedAt: 2,
      body: SUPERSEDED_TURN
    }
    expect(old.isAdmissibleAgentJournalRenderItem(row)).toBe(true)
    // Unknown is exactly what this turn carried before it was recorded: an interrupted end.
    expect(old.readAgentJournalTurnOutcome(SUPERSEDED_TURN)).toBeNull()
  })

  it('keeps a status row carrying a new arm, dropping only the verdict', () => {
    for (const outcome of NEW_ARMS) {
      const parsed = old.normalizeAgentStatusPayload({
        state: 'done',
        prompt: 'keep me',
        mainAgent: { state: 'done', outcome, stateStartedAt: 5 }
      })
      expect(parsed, outcome).toMatchObject({ state: 'done', prompt: 'keep me' })
      expect(parsed?.mainAgent, outcome).toEqual({ state: 'done', stateStartedAt: 5 })
      expect(parsed?.interrupted ?? false, outcome).toBe(false)
    }
  })

  it('keeps a sleeping agent record a newer build wrote with a new arm', () => {
    for (const outcome of NEW_ARMS) {
      const parsed = old.sleepingAgentSessionsByPaneKeySchema.safeParse({
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'done',
          capturedAt: 10,
          updatedAt: 9,
          mainAgent: { state: 'done', outcome, stateStartedAt: 9 },
          origin: 'live'
        }
      })
      expect(parsed.success, outcome).toBe(true)
      expect(parsed.data?.['tab1:pane-1'], outcome).toMatchObject({ prompt: 'continue' })
    }
  })
})
