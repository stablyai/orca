import { describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  agentMapAgentAriaLabel,
  agentMapStatusLabel,
  agentName
} from './agent-map-node-presentation'
import type { AgentMapAgentNode } from './agent-map-layout'
import { agentMapCardTopologyIdentity } from './agent-map-workspace-identity'

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string, options?: Record<string, unknown>) =>
    `${key}:${fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))}`
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

describe('agentMapAgentAriaLabel', () => {
  it('localizes unread and task details', () => {
    const card = {
      agentType: 'codex',
      paneKey: 'pane',
      conversationName: 'Reviewer',
      conversationNameExplicit: true,
      task: 'Review map',
      unseen: true
    } as DashboardCard
    const agent = {
      card,
      status: 'done',
      durationMinutes: 2,
      x: 0,
      y: 0,
      radius: 20
    } as AgentMapAgentNode

    expect(agentMapAgentAriaLabel(agent, 'Worktree', 'Project')).toContain(
      'dashboardPopout.map.agentUnreadDetail:, unread'
    )
    expect(agentMapAgentAriaLabel(agent, 'Worktree', 'Project')).toContain(
      'dashboardPopout.map.agentTaskDetail:, task: Review map'
    )
  })
})
