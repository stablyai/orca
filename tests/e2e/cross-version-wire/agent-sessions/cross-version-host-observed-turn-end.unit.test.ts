import { beforeAll, describe, expect, it } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout
} from '../release-checkouts/release-checkout'
import '../../../../src/shared/agent-session/view/structured-agent-session-projection'

// Pin an older reader that validates mainAgent.outcome; new interruption/unconfirmed arms must retain its normal done fallback.
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

/** The summary this build's host projects for a turn it settled with no provider verdict. */

describe('an older desktop reading a host-observed turn end', () => {
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
})
