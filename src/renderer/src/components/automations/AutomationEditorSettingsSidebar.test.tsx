// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationEditorSettingsSidebar } from './AutomationEditorSettingsSidebar'

// Why: only the Agent field is under test; the sibling fields own their own coverage.
vi.mock('./AutomationProjectCombobox', () => ({ default: () => null }))
vi.mock('./AutomationWorkspaceField', () => ({ AutomationWorkspaceField: () => null }))
vi.mock('./AutomationSessionField', () => ({ AutomationSessionField: () => null }))
vi.mock('./AutomationSchedulePicker', () => ({ AutomationSchedulePicker: () => null }))
vi.mock('./AutomationMissedRunGraceField', () => ({ AutomationMissedRunGraceField: () => null }))
vi.mock('./AutomationPrecheckFields', () => ({ AutomationPrecheckFields: () => null }))
vi.mock('./AutomationSetupDecisionField', () => ({ AutomationSetupDecisionField: () => null }))
vi.mock('./AutomationDestinationField', () => ({ AutomationDestinationField: () => null }))
vi.mock('./AutomationExtraAgentArgsField', () => ({ AutomationExtraAgentArgsField: () => null }))

const DRAFT: AutomationDraft = {
  name: '',
  prompt: '',
  agentId: 'codex',
  extraAgentArgs: '',
  projectId: '',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '30',
  preset: 'weekly',
  time: '09:15',
  dayOfWeek: '5',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  savedSchedule: null,
  scheduleWarning: null
}

function renderSidebar(onDraftChange: (updater: (d: AutomationDraft) => AutomationDraft) => void) {
  return render(
    <AutomationEditorSettingsSidebar
      isHermesTarget={false}
      isHermesCreate={false}
      repos={[]}
      projectHostSetups={[]}
      automationYamlHooksByRepoKey={{}}
      getAutomationHooksCacheKey={(repoId) => repoId}
      repoMap={new Map()}
      worktrees={[]}
      settings={null}
      draft={DRAFT}
      visibleAgents={AGENT_CATALOG}
      pickerTriggerClassName=""
      segmentedGroupClassName=""
      segmentedItemClassName=""
      onProjectChange={vi.fn()}
      onDraftChange={onDraftChange}
      onSetupDecisionTouched={vi.fn()}
    />
  )
}

afterEach(cleanup)

describe('AutomationEditorSettingsSidebar agent picker', () => {
  it('offers agents only, never Blank Terminal', () => {
    const onDraftChange = vi.fn()
    renderSidebar(onDraftChange)

    fireEvent.click(screen.getByRole('combobox'))

    expect(screen.queryByRole('option', { name: 'Blank Terminal' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }))
    expect(onDraftChange).toHaveBeenCalledTimes(1)
    const updater = onDraftChange.mock.calls[0][0]
    expect(updater(DRAFT).agentId).toBe('claude')
  })
})
