// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AutomationSchedulePreset } from '../../../../../shared/automations/automation-definition'
import { AutomationEditorDialog, type AutomationDraft } from './AutomationEditorDialog'
import { getSchedulePresetDraft } from './AutomationSchedulePicker'

vi.mock('./AutomationEditorPromptEditor', () => ({
  AutomationEditorPromptEditor: () => null,
  getAutomationPromptEditorRoot: () => null
}))
vi.mock('./AutomationEditorSettingsSidebar', () => ({
  AutomationEditorSettingsSidebar: ({
    onDraftChange
  }: {
    onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  }) => {
    const selectPreset = (preset: AutomationSchedulePreset): void =>
      onDraftChange((current) => ({ ...current, ...getSchedulePresetDraft(current, preset) }))
    const selectModel = (model: string): void =>
      onDraftChange((current) => ({ ...current, launchPreferences: { model } }))
    return (
      <>
        <button onClick={() => selectPreset('custom')}>Custom cron</button>
        <button onClick={() => selectPreset('weekdays')}>Weekdays</button>
        <button onClick={() => selectModel('opus')}>Opus</button>
        <button onClick={() => selectModel('sonnet')}>Sonnet</button>
      </>
    )
  }
}))

const DRAFT: AutomationDraft = {
  name: '',
  prompt: '',
  agentId: 'claude',
  extraAgentArgs: '',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '60',
  preset: 'weekdays',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  savedSchedule: null,
  scheduleWarning: null
}

function Harness({
  isEditing = false,
  initialDraft = DRAFT
}: {
  isEditing?: boolean
  initialDraft?: AutomationDraft
}): React.JSX.Element {
  const [open, setOpen] = React.useState(true)
  const [draft, setDraft] = React.useState(initialDraft)
  return (
    <TooltipProvider>
      <button onClick={() => setOpen(true)}>reopen</button>
      <AutomationEditorDialog
        open={open}
        isEditing={isEditing}
        isSaving={false}
        canSave
        repos={[]}
        projectHostSetups={[]}
        automationYamlHooksByRepoKey={{}}
        getAutomationHooksCacheKey={(repoId) => repoId}
        repoMap={new Map()}
        worktrees={[]}
        settings={null}
        draft={draft}
        onProjectChange={vi.fn()}
        onOpenChange={setOpen}
        onDraftChange={(updater) => setDraft(updater)}
        onSetupDecisionTouched={vi.fn()}
        onApplyTemplate={vi.fn()}
        onSave={vi.fn()}
      />
    </TooltipProvider>
  )
}

function backdrop(): Element {
  const overlay = document.querySelector('[data-slot="dialog-overlay"]')
  if (!overlay) {
    throw new Error('Missing dialog backdrop')
  }
  return overlay
}

afterEach(cleanup)

describe('AutomationEditorDialog outside dismissal', () => {
  it('keeps an edited draft open on a backdrop click while Escape still discards it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(screen.getByLabelText('Automation name'), 'Nightly')

    await user.click(backdrop())

    expect(screen.getByLabelText<HTMLTextAreaElement>('Automation name').value).toBe('Nightly')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
