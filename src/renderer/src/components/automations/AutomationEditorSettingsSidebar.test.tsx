// @vitest-environment happy-dom

import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationEditorSettingsSidebar } from './AutomationEditorSettingsSidebar'

const initialDraft: AutomationDraft = {
  name: 'Daily check',
  prompt: 'echo ready',
  agentId: 'codex',
  projectId: '',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '60',
  preset: 'daily',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  scheduleWarning: null
}

function Editor(): React.JSX.Element {
  const [draft, setDraft] = useState(initialDraft)
  return (
    <TooltipProvider>
      <AutomationEditorSettingsSidebar
        isHermesTarget={false}
        isHermesCreate={false}
        repos={[]}
        projectHostSetups={[]}
        automationYamlHooksByRepoKey={{}}
        getAutomationHooksCacheKey={(id) => id}
        repoMap={new Map()}
        worktrees={[]}
        settings={null}
        draft={draft}
        visibleAgents={AGENT_CATALOG}
        pickerTriggerClassName=""
        segmentedGroupClassName=""
        segmentedItemClassName=""
        onProjectChange={() => {}}
        onSetupDecisionTouched={() => {}}
        onDraftChange={setDraft}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('automation agent selection', () => {
  it('retains Blank Terminal after selection and allows switching back to an agent', () => {
    render(<Editor />)
    const trigger = screen
      .getAllByRole('combobox')
      .find((element) => element.textContent === 'Codex')!

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Blank Terminal' }))

    expect(trigger.textContent).toBe('Blank Terminal')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('radio', { name: 'Reuse' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }))

    expect(trigger.textContent).toBe('Claude')
  })
})
