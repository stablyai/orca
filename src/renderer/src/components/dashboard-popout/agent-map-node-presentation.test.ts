import { describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { agentMapStatusLabel, agentName } from './agent-map-node-presentation'
import { agentMapCardTopologyIdentity } from './agent-map-workspace-identity'

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string) => `${key}:${fallback}`
}))

describe('agentName', () => {
  it('shows an explicit agent name instead of a task sentence', () => {
    expect(
      agentName({
        conversationName: 'Conversation title',
        orchestrationDisplayName: 'Reviewer',
        task: 'Run final adversarial regression review',
        agentType: 'codex'
      } as DashboardCard)
    ).toBe('Reviewer')
    expect(
      agentName({
        conversationName: 'Conversation title',
        conversationNameExplicit: true,
        orchestrationDisplayName: '  ',
        task: 'Run final adversarial regression review',
        agentType: 'codex'
      } as DashboardCard)
    ).toBe('Conversation title')
    expect(
      agentName({
        conversationName: 'Run final adversarial regression review',
        conversationNameExplicit: false,
        orchestrationDisplayName: '  ',
        task: 'Run final adversarial regression review',
        agentType: 'codex'
      } as DashboardCard)
    ).toBe('Codex')
    expect(
      agentName({
        conversationName: 'Older peer title',
        orchestrationDisplayName: '  ',
        task: 'Run final adversarial regression review',
        agentType: 'codex'
      } as DashboardCard)
    ).toBe('Older peer title')
  })

  it('keeps mixed-version agent labels and identities distinct', () => {
    const legacyBase = {
      repoId: 'repo',
      worktreeId: 'worktree',
      paneKey: 'pane',
      orchestrationDisplayName: '  ',
      agentType: 'codex'
    } as DashboardCard
    const namedLegacyAgent = {
      ...legacyBase,
      conversationName: 'Legacy reviewer',
      task: 'Review the change'
    }
    const taskLegacyAgent = {
      ...legacyBase,
      task: 'Build the change'
    }

    expect(agentName(namedLegacyAgent)).toBe('Legacy reviewer')
    expect(agentName(taskLegacyAgent)).toBe('Build the change')
    expect(agentMapCardTopologyIdentity(namedLegacyAgent)).not.toBe(
      agentMapCardTopologyIdentity(taskLegacyAgent)
    )
  })
})

describe('agentMapStatusLabel', () => {
  it('localizes the map-only acknowledged completion state', () => {
    expect(agentMapStatusLabel('done-seen')).toBe('dashboardPopout.map.status.doneSeen:Done, seen')
  })

  it('keeps shared agent states on their existing labels', () => {
    expect(agentMapStatusLabel('working')).toBe('Working')
    expect(agentMapStatusLabel('done')).toBe('Done')
  })
})
