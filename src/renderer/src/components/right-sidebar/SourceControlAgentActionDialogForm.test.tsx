import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlAgentActionDialogForm } from './SourceControlAgentActionDialogForm'
import type { GlobalSettings, Repo } from '../../../../shared/types'

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({ value }: { value: string | null }) =>
    React.createElement('div', { 'data-agent-value': value ?? '' })
}))

vi.mock('@/components/ui/dialog', () => ({
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children)
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children, value }: { children?: ReactNode; value: string }) =>
    React.createElement('div', { 'data-select-item': value }, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))

vi.mock('../source-control/SourceControlActionVariableChips', () => ({
  SourceControlActionVariableChips: ({
    variablePreviews
  }: {
    variablePreviews?: Partial<Record<string, string>>
  }) =>
    React.createElement('div', {
      'data-variable-previews': JSON.stringify(variablePreviews ?? {})
    })
}))

function renderForm(
  overrides: Partial<React.ComponentProps<typeof SourceControlAgentActionDialogForm>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(SourceControlAgentActionDialogForm, {
      actionId: 'resolveConflicts',
      baseCommandInput: 'Resolve the merge conflicts reported for this pull request.',
      agentOptions: [],
      selectedAgent: 'codex',
      hasEnabledAgents: true,
      detecting: false,
      statusCopy: null,
      agentArgs: '',
      commandTemplate: '{basePrompt}',
      savedCommandInputTemplate: '{basePrompt}',
      saveLaunchRecipe: true,
      saveTargetValue: 'global',
      saveTargets: [
        { value: 'none', label: "Don't save" },
        { value: 'global', label: 'All repositories' }
      ],
      settings: null,
      repo: null,
      canSaveAgentDefault: true,
      deliveryPlan: { status: 'idle' },
      canStart: true,
      isStarting: false,
      startLabel: 'Start agent',
      onSelectedAgentChange: () => {},
      onAgentArgsChange: () => {},
      onCommandTemplateChange: () => {},
      onSaveLaunchRecipeChange: () => {},
      onSaveAgentDefaultChange: () => {},
      onCancel: () => {},
      onStart: () => {},
      ...overrides
    })
  )
}

function settingsWithSavedGlobalRecipe(): GlobalSettings {
  return {
    sourceControlAi: {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customAgentCommand: '',
      instructionsByOperation: {},
      actions: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}'
        }
      }
    }
  } as unknown as GlobalSettings
}

const repoWithoutSavedRecipe = {
  id: 'repo-1',
  sourceControlAi: { enabled: true }
} satisfies Pick<Repo, 'id' | 'sourceControlAi'>

describe('SourceControlAgentActionDialogForm', () => {
  it('passes the base prompt preview to the variable chip hover content', () => {
    const markup = renderForm()

    expect(markup).toContain('Resolve the merge conflicts reported for this pull request.')
  })

  it('checks already-saved copy against the selected save target', () => {
    const settings = settingsWithSavedGlobalRecipe()
    const saveTargets = [
      { value: 'none', label: "Don't save" },
      { value: 'repo', label: 'This repository' },
      { value: 'global', label: 'All repositories' }
    ]

    const globalMarkup = renderForm({
      settings,
      repo: repoWithoutSavedRecipe,
      saveTargets,
      saveTargetValue: 'global'
    })
    const repoMarkup = renderForm({
      settings,
      repo: repoWithoutSavedRecipe,
      saveTargets,
      saveTargetValue: 'repo'
    })

    expect(globalMarkup).toContain('Launch recipe already saved')
    expect(globalMarkup).not.toContain('Save &amp; start agent')
    expect(repoMarkup).not.toContain('Launch recipe already saved')
    expect(repoMarkup).toContain('Save &amp; start agent')
  })
})
