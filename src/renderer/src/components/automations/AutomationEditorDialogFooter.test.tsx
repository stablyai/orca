// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { AutomationEditorDialogFooter } from './AutomationEditorDialogFooter'
import type { AutomationDraft } from './AutomationEditorDialog'

// Why: Tooltip needs a provider in the app; stub so the footer renders standalone.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

// Why: the project picker reads repos from the app store, which this test does not exercise.
vi.mock('./AutomationProjectCombobox', () => ({
  default: () => <div />
}))

afterEach(cleanup)

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000000',
  addedAt: 1
}

const DRAFT: AutomationDraft = {
  name: 'nightly',
  prompt: 'Run checks',
  agentId: 'codex',
  projectId: REPO.id,
  workspaceMode: 'existing',
  workspaceId: 'worktree-1',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '60',
  preset: 'daily',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  missedRunGraceMinutes: '60',
  scheduleWarning: null
}

function renderFooter(): void {
  render(
    <AutomationEditorDialogFooter
      isEditing={false}
      isEditingExternal={false}
      isHermesTarget={false}
      isHermesCreate={false}
      isSaving={false}
      canSave
      repos={[REPO]}
      projectHostSetups={[]}
      automationYamlHooksByRepoKey={{}}
      getAutomationHooksCacheKey={(repoId) => repoId}
      repoMap={new Map([[REPO.id, REPO]])}
      worktrees={[]}
      settings={null}
      draft={DRAFT}
      visibleAgents={AGENT_CATALOG}
      scheduleField={null}
      pickerTriggerClassName=""
      modeToggleItemClassName=""
      onProjectChange={vi.fn()}
      onDraftChange={vi.fn()}
      onSetupDecisionTouched={vi.fn()}
      onOpenChange={vi.fn()}
      onSave={vi.fn()}
    />
  )
}

describe('AutomationEditorDialogFooter agent picker', () => {
  it('does not offer Blank Terminal, which the draft cannot store', () => {
    renderFooter()

    const agentTrigger = document.querySelector('button[data-agent-combobox-root="true"]')
    expect(agentTrigger?.textContent).toContain('Codex')
    fireEvent.click(agentTrigger as Element)

    expect(screen.getByRole('option', { name: 'Claude' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Blank Terminal' })).toBeNull()
  })
})
