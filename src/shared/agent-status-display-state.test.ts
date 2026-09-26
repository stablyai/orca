import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_DISPLAY_PRIORITY,
  agentChildWorkDisplay,
  agentMainTurnEnding,
  isCleanAgentTurnCompletion,
  resolveAgentPaneDisplayState,
  resolveAgentWorktreeDisplayStatus
} from './agent-status-display-state'
import { foldAgentLeadStatus } from './agent-lead-status-fold'
import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentMainAgentStatus } from './main-agent-status'
import type { AgentStatusState } from './agent-status-types'

const main = (
  state: AgentStatusState,
  outcome?: AgentMainAgentStatus['outcome']
): AgentMainAgentStatus => ({ state, ...(outcome ? { outcome } : {}), stateStartedAt: 10 })

describe('rows without mainAgent read as today', () => {
  it('maps each lifecycle state to its display', () => {
    expect(resolveAgentPaneDisplayState({ state: 'working' })).toBe('working')
    expect(resolveAgentPaneDisplayState({ state: 'working', workingMode: 'monitoring' })).toBe(
      'monitoring'
    )
    expect(resolveAgentPaneDisplayState({ state: 'waiting' })).toBe('waiting')
    expect(resolveAgentPaneDisplayState({ state: 'blocked' })).toBe('blocked')
    expect(resolveAgentPaneDisplayState({ state: 'done' })).toBe('done')
    expect(resolveAgentPaneDisplayState({ state: 'done', interrupted: true })).toBe('interrupted')
  })

  it('applies the reader decay to live states', () => {
    expect(resolveAgentPaneDisplayState({ state: 'working' }, 'unverifiable')).toBe('unverifiable')
    expect(resolveAgentPaneDisplayState({ state: 'waiting' }, 'idle')).toBe('idle')
  })

  it('never reads a failure without a main agent verdict', () => {
    expect(agentMainTurnEnding({ state: 'done' })).toBeUndefined()
    expect(agentMainTurnEnding({ state: 'done', interrupted: true })).toBe('cancellation')
  })
})

describe('with mainAgent, only its record answers how the turn ended', () => {
  it('ignores a row interrupted flag the main agent record does not carry', () => {
    const row = { state: 'done' as const, interrupted: true, mainAgent: main('done') }
    expect(agentMainTurnEnding(row)).toBeUndefined()
    expect(resolveAgentPaneDisplayState(row)).toBe('done')
  })

  it('reads a native-chat cancellation that carries no interrupted flag as interrupted', () => {
    expect(
      resolveAgentPaneDisplayState({ state: 'done', mainAgent: main('done', 'cancellation') })
    ).toBe('interrupted')
  })

  it('agrees with producers that set both the flag and the verdict', () => {
    const row = {
      state: 'done' as const,
      interrupted: true,
      mainAgent: main('done', 'cancellation')
    }
    expect(resolveAgentPaneDisplayState(row)).toBe(
      resolveAgentPaneDisplayState({ state: 'done', interrupted: true })
    )
  })

  it('shows a plain failure as failed', () => {
    expect(
      resolveAgentPaneDisplayState({ state: 'done', mainAgent: main('done', 'failure') })
    ).toBe('failed')
  })

  it('treats a success verdict as a clean done', () => {
    expect(
      resolveAgentPaneDisplayState({ state: 'done', mainAgent: main('done', 'success') })
    ).toBe('done')
  })
})

describe('R2 precedence over the separated facts', () => {
  it('shows a failure held open by working child work as failed', () => {
    expect(
      resolveAgentPaneDisplayState({ state: 'working', mainAgent: main('done', 'failure') })
    ).toBe('failed')
  })

  it('shows a failure held open by watch loops as failed', () => {
    expect(
      resolveAgentPaneDisplayState({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: main('done', 'failure')
      })
    ).toBe('failed')
  })

  it("lets a child's human wait outrank the main agent's failure", () => {
    expect(
      resolveAgentPaneDisplayState({ state: 'waiting', mainAgent: main('done', 'failure') })
    ).toBe('waiting')
  })

  it('reads a cancellation with live child work as the child work', () => {
    expect(
      resolveAgentPaneDisplayState({ state: 'working', mainAgent: main('done', 'cancellation') })
    ).toBe('working')
    expect(
      resolveAgentPaneDisplayState({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: main('done', 'cancellation')
      })
    ).toBe('monitoring')
  })

  it('keeps a failure through reader decay', () => {
    expect(
      resolveAgentPaneDisplayState(
        { state: 'working', mainAgent: main('done', 'failure') },
        'unverifiable'
      )
    ).toBe('failed')
    expect(
      resolveAgentPaneDisplayState({ state: 'waiting', mainAgent: main('done', 'failure') }, 'idle')
    ).toBe('failed')
  })

  it('shows a working main agent as working', () => {
    expect(resolveAgentPaneDisplayState({ state: 'working', mainAgent: main('working') })).toBe(
      'working'
    )
  })

  it('orders the display priority with failed below a human wait and above working', () => {
    expect(AGENT_STATUS_DISPLAY_PRIORITY).toEqual([
      'waiting',
      'blocked',
      'failed',
      'working',
      'monitoring',
      'interrupted',
      'done',
      'unverifiable',
      'idle'
    ])
  })
})

describe('the child-work residual inverts the lead fold', () => {
  const leads: AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']
  const liveness: AgentChildWorkLiveness[] = ['waiting', 'working', 'monitoring', null]
  for (const leadState of leads) {
    for (const childWorkLiveness of liveness) {
      it(`recovers the child wait for lead=${leadState} child=${String(childWorkLiveness)}`, () => {
        const folded = foldAgentLeadStatus({ leadState, childWorkLiveness })
        const row = {
          state: folded.stateName,
          ...(folded.workingMode ? { workingMode: folded.workingMode } : {}),
          mainAgent: main(leadState)
        }
        const residual = agentChildWorkDisplay(row)
        const rowWaits = folded.stateName === 'waiting' || folded.stateName === 'blocked'
        const mainWaits = leadState === 'waiting' || leadState === 'blocked'
        expect(residual === 'waiting' || residual === 'blocked').toBe(rowWaits && !mainWaits)
        const display = resolveAgentPaneDisplayState(row)
        expect(display === 'waiting' || display === 'blocked').toBe(rowWaits)
        if (leadState === 'done' && childWorkLiveness !== null && childWorkLiveness !== 'waiting') {
          expect(residual).toBe(childWorkLiveness)
        }
      })
    }
  }
})

describe('resolveAgentWorktreeDisplayStatus', () => {
  it('ranks a human wait, then failed, then the base rollup', () => {
    expect(
      resolveAgentWorktreeDisplayStatus({ base: 'working', hasHumanWait: true, hasFailed: true })
    ).toBe('permission')
    expect(
      resolveAgentWorktreeDisplayStatus({
        base: 'permission',
        hasHumanWait: false,
        hasFailed: true
      })
    ).toBe('permission')
    expect(
      resolveAgentWorktreeDisplayStatus({ base: 'working', hasHumanWait: false, hasFailed: true })
    ).toBe('failed')
    expect(
      resolveAgentWorktreeDisplayStatus({ base: 'done', hasHumanWait: false, hasFailed: false })
    ).toBe('done')
  })
})

describe('isCleanAgentTurnCompletion', () => {
  it('accepts only a done turn that neither failed nor was cancelled', () => {
    expect(isCleanAgentTurnCompletion({ state: 'done' })).toBe(true)
    expect(isCleanAgentTurnCompletion({ state: 'done', mainAgent: main('done', 'success') })).toBe(
      true
    )
    expect(isCleanAgentTurnCompletion({ state: 'done', interrupted: true })).toBe(false)
    expect(isCleanAgentTurnCompletion({ state: 'done', mainAgent: main('done', 'failure') })).toBe(
      false
    )
    expect(
      isCleanAgentTurnCompletion({ state: 'done', mainAgent: main('done', 'cancellation') })
    ).toBe(false)
    expect(isCleanAgentTurnCompletion({ state: 'working' })).toBe(false)
  })
})
