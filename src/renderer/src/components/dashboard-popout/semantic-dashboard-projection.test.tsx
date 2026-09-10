// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentStateDot } from '@/components/AgentStateDot'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  normalizeAgentStatusPayload,
  type AgentStatusIpcPayload
} from '../../../../shared/agent-status-types'
import { dashboardCardDisplayState } from '../../../../shared/dashboard-snapshot'
import { buildDashboardSnapshot } from '../dashboard/build-dashboard-snapshot'
import {
  PROJECTION_NOW,
  semanticProjectionEntry,
  semanticProjectionState
} from '../dashboard/semantic-projection-fixture'
import { patchDashboardSnapshotFromAgentStatus } from './dashboard-agent-status-patch'
import { AgentKanbanCard } from './AgentKanbanCard'
import { dashboardCardDotState } from '../dashboard/dashboard-row-bucket'

afterEach(cleanup)
const openTerminal = () => {}

function produced(interrupted: boolean | undefined, seen = false) {
  return buildDashboardSnapshot(
    semanticProjectionState(semanticProjectionEntry({ interrupted }), seen),
    PROJECTION_NOW
  )
}
function update(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    ...semanticProjectionEntry(),
    connectionId: null,
    receivedAt: PROJECTION_NOW + 1,
    ...overrides
  }
}

describe('semantic dashboard producer to renderer', () => {
  it.each([false, true])(
    'preserves interruption through serialized snapshot and shipping Kanban (seen=%s)',
    (seen) => {
      const snapshot = produced(true, seen)
      expect(snapshot.cards).toHaveLength(1)
      expect(JSON.parse(JSON.stringify(snapshot)).cards[0].interrupted).toBe(true)
      const card = snapshot.cards[0]
      expect(card.interrupted).toBe(true)
      expect(card.bucket).toBe(seen ? 'idle' : 'done')
      render(
        <TooltipProvider>
          <AgentKanbanCard card={card} now={PROJECTION_NOW} onOpenTerminal={openTerminal} />
        </TooltipProvider>
      )
      expect(screen.getByLabelText('Interrupted')).toBeInTheDocument()
      expect(screen.queryByLabelText('Done')).not.toBeInTheDocument()
    }
  )

  it('rerenders the memoized shipping card when only interruption changes', () => {
    const card = produced(false).cards[0]
    const { rerender } = render(
      <TooltipProvider>
        <AgentKanbanCard card={card} now={PROJECTION_NOW} onOpenTerminal={openTerminal} />
      </TooltipProvider>
    )
    expect(screen.getByLabelText('Done')).toBeInTheDocument()
    rerender(
      <TooltipProvider>
        <AgentKanbanCard
          card={{ ...card, interrupted: true }}
          now={PROJECTION_NOW}
          onOpenTerminal={openTerminal}
        />
      </TooltipProvider>
    )
    expect(screen.getByLabelText('Interrupted')).toBeInTheDocument()
    rerender(
      <TooltipProvider>
        <AgentKanbanCard
          card={{ ...card, interrupted: undefined }}
          now={PROJECTION_NOW}
          onOpenTerminal={openTerminal}
        />
      </TooltipProvider>
    )
    expect(screen.getByLabelText('Done')).toBeInTheDocument()
  })

  it('keeps the legacy unverifiable snapshot bucket without minting execution facts', () => {
    expect(dashboardCardDotState('unverifiable')).toBe('idle')
  })

  it.each([false, undefined])(
    'clears interruption on next accepted state with discriminator %s',
    (interrupted) => {
      const snapshot = produced(true)
      const patched = patchDashboardSnapshotFromAgentStatus(
        snapshot,
        update({ interrupted })
      ).snapshot
      expect(patched.cards[0].interrupted).toBeUndefined()
      render(
        <TooltipProvider>
          <AgentStateDot state={dashboardCardDisplayState(patched.cards[0])} />
        </TooltipProvider>
      )
      expect(screen.getByLabelText('Done')).toBeInTheDocument()
      expect(screen.queryByLabelText('Interrupted')).not.toBeInTheDocument()
    }
  )

  it('preserves interruption in a live patch from ordinary completion', () => {
    const snapshot = produced(false)
    const patched = patchDashboardSnapshotFromAgentStatus(snapshot, update()).snapshot
    expect(patched.cards[0].interrupted).toBe(true)
    render(
      <TooltipProvider>
        <AgentStateDot state={dashboardCardDisplayState(patched.cards[0])} />
      </TooltipProvider>
    )
    expect(screen.getByLabelText('Interrupted')).toBeInTheDocument()
  })

  it.each([
    { receivedAt: PROJECTION_NOW },
    { worktreeId: 'wrong-workspace' },
    { providerSessionOnly: true }
  ])('rejects inadmissible semantic patch %j', (overrides) => {
    const snapshot = produced(true)
    expect(
      patchDashboardSnapshotFromAgentStatus(
        snapshot,
        update({ state: 'working', interrupted: false, ...overrides })
      ).snapshot
    ).toBe(snapshot)
  })

  it('keeps SSH folder execution identity while projecting interrupted', () => {
    const state = semanticProjectionState(semanticProjectionEntry())
    state.repos = state.repos.map((repo) => ({
      ...repo,
      kind: 'folder',
      executionHostId: 'ssh:synthetic'
    }))
    const snapshot = buildDashboardSnapshot(state, PROJECTION_NOW)
    expect(snapshot.cards[0]).toMatchObject({
      interrupted: true,
      hostKind: 'ssh',
      executionHostId: 'ssh:synthetic',
      workspaceKind: 'folder'
    })
  })

  it('clears interruption on an ordinary working state even if a stale flag is supplied', () => {
    const patched = patchDashboardSnapshotFromAgentStatus(
      produced(true),
      update({ state: 'working', interrupted: true })
    ).snapshot
    expect(patched.cards[0].interrupted).toBeUndefined()
    expect(dashboardCardDisplayState(patched.cards[0])).toBe('working')
  })

  it.each(['claude', 'codex', 'gemini'] as const)(
    'uses normalized provider facts without execution inference for %s',
    (agentType) => {
      const normalized = normalizeAgentStatusPayload({
        state: 'working',
        workingMode: 'monitoring',
        interrupted: true
      })
      expect(normalized?.interrupted).toBeUndefined()
      const snapshot = buildDashboardSnapshot(
        semanticProjectionState(
          semanticProjectionEntry({ ...normalized, agentType, state: 'working' })
        ),
        PROJECTION_NOW
      )
      expect(snapshot.cards[0].dotState).toBe('working')
      expect(snapshot.cards[0].interrupted).toBeUndefined()
      expect(dashboardCardDisplayState(snapshot.cards[0])).toBe('monitoring')
    }
  )
})
