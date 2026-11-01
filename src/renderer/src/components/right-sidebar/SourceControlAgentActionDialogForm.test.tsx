import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { sourceControlActionRecipeEntry } from '../../../../shared/source-control-action-selection'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlAgentActionDialogForm } from './SourceControlAgentActionDialogForm'

vi.mock('@/components/agent/AgentLaunchPicker', () => ({
  AgentLaunchPicker: ({
    agent,
    draftForEntry
  }: {
    agent: string | null
    draftForEntry?: (entry: AgentPickerEntry) => unknown
  }) =>
    React.createElement('div', {
      'data-agent-value': agent ?? '',
      'data-allow-blank': 'false',
      'data-draft':
        draftForEntry && agent && (agent === 'codex' || agent === 'antigravity')
          ? JSON.stringify(
              draftForEntry({
                agent,
                label: agent,
                rows: [],
                surfaces: ['chat', 'terminal'],
                defaultSurface: 'chat',
                terminal: {},
                structured: {},
                catalog: { origin: 'unknown' }
              })
            )
          : ''
    })
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
  overrides: Partial<
    Omit<React.ComponentProps<typeof SourceControlAgentActionDialogForm>, 'recipe'>
  > & { recipe?: SourceControlActionRecipe } = {}
): string {
  return renderToStaticMarkup(
    React.createElement(SourceControlAgentActionDialogForm, {
      actionId: 'resolveConflicts',
      baseCommandInput: 'Resolve the merge conflicts reported for this pull request.',
      agentScopeNote: null,
      agentOptions: [],
      selectedAgent: 'codex',
      hasEnabledAgents: true,
      detecting: false,
      surfaceRows: {
        model: { state: 'loading', placeholderCount: 0 },
        selection: { ready: true, cli: false },
        onPick: () => {}
      },
      statusCopy: null,
      agentArgs: '',
      agentArgsApply: true,
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
      onAgentPick: () => {},
      onAgentArgsChange: () => {},
      onCommandTemplateChange: () => {},
      onSaveLaunchRecipeChange: () => {},
      onSaveAgentDefaultChange: () => {},
      onCancel: () => {},
      onStart: () => {},
      ...overrides,
      recipe: sourceControlActionRecipeEntry(
        overrides.recipe ?? {
          agentId: overrides.selectedAgent ?? 'codex',
          commandInputTemplate: overrides.commandTemplate ?? '{basePrompt}',
          ...(overrides.agentArgs !== undefined ? { agentArgs: overrides.agentArgs } : {})
        }
      )
    })
  )
}

describe('SourceControlAgentActionDialogForm', () => {
  it('names the saved choice on chat and terminal launches alike', () => {
    const recipe = {
      agentId: 'codex' as const,
      launchPreferences: {
        agentId: 'codex' as const,
        model: 'saved',
        permissionMode: 'ask' as const
      }
    }
    expect(renderForm({ recipe, agentArgsApply: true })).toContain('saved')
    expect(
      renderForm({
        recipe: {
          ...recipe,
          launchPreferences: {
            agentId: 'claude',
            permissionMode: 'ask',
            modelSelection: {
              base: 'inherit',
              model: { agentId: 'codex', value: 'saved' }
            }
          }
        },
        agentArgsApply: false
      })
    ).toContain('saved')
    expect(
      renderForm({
        recipe: {
          agentId: 'codex',
          launchPreferences: {
            agentId: 'codex',
            modelSelection: {
              base: 'default',
              options: { effort: { agentId: 'codex', value: 'high' } }
            }
          }
        }
      })
    ).toContain('high')
    expect(
      renderForm({
        selectedAgent: 'antigravity',
        recipe: {
          agentId: 'antigravity',
          launchPreferences: { agentId: 'antigravity', permissionMode: 'ask' }
        }
      })
    ).toContain('ask')
  })
})

describe('CLI arguments field applicability', () => {
  it('keeps terminal arguments inside the shared picker', () => {
    const markup = renderForm({ agentArgsApply: true })

    expect(markup).toContain('data-draft')
    expect(markup).not.toContain('source-control-agent-cli-args')
  })
})
