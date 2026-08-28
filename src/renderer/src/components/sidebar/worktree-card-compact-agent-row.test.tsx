// @vitest-environment happy-dom
/**
 * Why a render test: the change is a WIRING one. The formatter is unit-tested on its own;
 * these assert the combined label actually reaches the row, that the now-redundant raw
 * model chip is gone, and that child-row activation still targets the parent pane.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))
vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

afterEach(() => {
  cleanup()
})

function agentRow(overrides: {
  model?: string
  prompt?: string
  displayName?: string
  agentType?: string
  rowSource?: 'subagent'
  paneKey?: string
  activationPaneKey?: string
}): DashboardAgentRow {
  const paneKey = overrides.paneKey ?? 'pane-1'
  return {
    paneKey,
    entry: {
      state: 'working',
      prompt: overrides.prompt ?? '',
      updatedAt: 1,
      stateStartedAt: 1,
      agentType: overrides.agentType ?? 'codex',
      model: overrides.model,
      paneKey,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      stateHistory: [],
      ...(overrides.displayName
        ? {
            orchestration: {
              taskId: 'task-1',
              dispatchId: 'ctx-1',
              displayName: overrides.displayName
            }
          }
        : {})
    },
    tab: { id: 'tab-1' },
    agentType: overrides.agentType ?? 'codex',
    rowSource: overrides.rowSource,
    state: 'working',
    startedAt: 1,
    ...(overrides.activationPaneKey ? { activationPaneKey: overrides.activationPaneKey } : {})
  } as unknown as DashboardAgentRow
}

function renderRow(
  agent: DashboardAgentRow,
  onActivate = vi.fn()
): { onActivate: typeof onActivate } {
  render(<CompactAgentRow agent={agent} now={2} onActivate={onActivate} />)
  return { onActivate }
}

describe('CompactAgentRow model label', () => {
  it('names a Sol parent before its generated feature', () => {
    renderRow(agentRow({ model: 'gpt-5.6-sol', prompt: 'Inspect scraper pipeline' }))
    expect(screen.getByText('Sol: Inspect scraper pipeline')).toBeTruthy()
    // The trailing raw-model chip is redundant once the label names the model.
    expect(screen.queryByText('gpt-5.6-sol')).toBeNull()
    // The tooltip carries the full combined label, which the row itself truncates.
    const row = document.querySelector('.compact-agent-row')
    expect(row?.getAttribute('title')).toContain('Sol: Inspect scraper pipeline')
  })

  it('names a Fable parent the same way', () => {
    renderRow(agentRow({ model: 'claude-fable-5', prompt: 'Rework the replay gate' }))
    expect(screen.getByText('Fable: Rework the replay gate')).toBeTruthy()
    expect(screen.queryByText('claude-fable-5')).toBeNull()
  })

  it('names a native Terra child from its description', () => {
    renderRow(
      agentRow({
        model: 'gpt-5.6-terra',
        prompt: 'Map backend API layer',
        rowSource: 'subagent',
        agentType: 'api-mapper'
      })
    )
    expect(screen.getByText('Terra: Map backend API layer')).toBeTruthy()
  })

  it('names a native Claude child from its description', () => {
    renderRow(
      agentRow({
        model: 'claude-sonnet-5',
        prompt: 'Survey the test suite',
        rowSource: 'subagent',
        agentType: 'test-surveyor'
      })
    )
    expect(screen.getByText('Sonnet: Survey the test suite')).toBeTruthy()
  })

  it('keeps an unknown model readable rather than dropping it', () => {
    renderRow(agentRow({ model: 'mystery-model-1', prompt: 'Do the thing' }))
    expect(screen.getByText('mystery-model-1: Do the thing')).toBeTruthy()
  })

  it('leaves a row without a model exactly as it was', () => {
    renderRow(agentRow({ prompt: 'Inspect scraper pipeline' }))
    expect(screen.getByText('Inspect scraper pipeline')).toBeTruthy()
  })

  it('does not double-prefix an orchestration displayName that is already formatted', () => {
    renderRow(
      agentRow({
        model: 'gpt-5.6-terra',
        prompt: 'You are working inside Orca, a multi-agent IDE. === TASK === Inspect pipeline',
        displayName: 'Terra (medium): Inspect scraper pipeline'
      })
    )
    expect(screen.getByText('Terra (medium): Inspect scraper pipeline')).toBeTruthy()
    expect(screen.queryByText(/Terra: Terra/u)).toBeNull()
  })

  it('still activates the parent pane from a child row', () => {
    const { onActivate } = renderRow(
      agentRow({
        model: 'gpt-5.6-luna',
        prompt: 'Check the migration',
        rowSource: 'subagent',
        paneKey: 'pane-1 subagent:abc',
        activationPaneKey: 'pane-parent'
      })
    )
    fireEvent.click(screen.getByText('Luna: Check the migration'))
    expect(onActivate).toHaveBeenCalledWith('tab-1', 'pane-parent')
  })
})
