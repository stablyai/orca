// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import './settings-persistence-test-fixture'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import {
  SOURCE_CONTROL_ACTION_IDS,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import {
  computeActionDirtyById,
  dropRepoLegacyInstructionForAction
} from './repository-source-control-ai-draft'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'
import { SourceControlAiActionRecipeDefaults } from './SourceControlAiActionRecipeDefaults'
import { useAppStore } from '../../store'
import { TooltipProvider } from '../ui/tooltip'
describe('RepositorySourceControlAiEnablement', () => {
  it('describes repo enablement as Source Control AI action visibility', () => {
    const markup = renderToStaticMarkup(
      React.createElement(RepositorySourceControlAiEnablement, {
        value: false,
        source: { enabled: true } as SourceControlAiSettings,
        onChange: () => {}
      })
    )

    expect(markup).toContain('Show Source Control AI actions')
    expect(markup).toContain('Controls whether Source Control AI buttons are shown')
    expect(markup).toContain('separate features follows those features&#x27; settings')
    expect(markup).toContain('Show')
    expect(markup).not.toContain('Source Control AI enabled')
  })
})

describe('RepositorySourceControlAiActionRows', () => {
  it.each([
    { agent: 'codex', detected: ['codex'] },
    { agent: 'opencode', detected: ['opencode'] },
    { agent: 'codex', detected: ['claude'] }
  ] as const)(
    'keeps saved $agent controls bound across detection returning $detected',
    async ({ agent, detected }) => {
      useAppStore.getState().clearLocalDetectedAgents()
      const settings = useAppStore.getState().settings!
      const recipe = {
        agentId: agent,
        launchPreferences: {
          agentId: agent,
          permissionMode: 'ask' as const,
          model: 'saved',
          options: { fastMode: 'false' }
        },
        agentArgs: '--saved-cli',
        commandInputTemplate: 'kept-template'
      }
      const source = {
        ...settings.sourceControlAi!,
        enabled: true,
        actions: { fixCommitFailure: recipe }
      }
      const originalRecipe = JSON.stringify(recipe)
      let finish: (ids: string[]) => void = () => {}
      const detectAgents = vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            finish = resolve
          })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { preflight: { detectAgents } }
      })
      useAppStore.setState({
        settings: { ...settings, defaultTuiAgent: 'claude', sourceControlAi: source },
        settingsSearchQuery: '',
        localDetectedAgentIdsByContext: {}
      })
      const ensure = vi.spyOn(useAppStore.getState(), 'ensureNativeDetectedAgents')
      const writeConfig = vi.fn()
      const onEdit = vi.fn()
      const view = render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(SourceControlAiActionRecipeDefaults, {
            config: source,
            defaultTuiAgent: 'claude',
            searchQuery: '',
            writeConfig
          }),
          React.createElement(RepositorySourceControlAiActionRows, {
            repoId: 'repo-1',
            repoAi: { actionOverrides: { fixCommitFailure: recipe } },
            source,
            defaultTuiAgent: 'claude',
            savingActionIds: {},
            actionDirtyById: computeActionDirtyById({}, {}, {}),
            onActionModeChange: onEdit,
            onActionAgentChange: onEdit,
            onActionLaunchPreferencesChange: onEdit,
            onActionTemplateChange: onEdit,
            onActionAgentArgsChange: onEdit,
            onAppendVariable: onEdit,
            onActionDiscard: onEdit,
            onActionSave: onEdit
          })
        )
      )
      await act(async () => {})
      const cards = Array.from(view.container.querySelectorAll('textarea'))
        .filter((field) => field.value === 'kept-template')
        .map((field) => field.parentElement!.closest('.rounded-md')!)
      expect(cards).toHaveLength(2)
      expect(ensure).toHaveBeenCalledTimes(2)
      expect(detectAgents).toHaveBeenCalledTimes(1)
      const pendingContent = cards.map((card) => card.textContent)
      for (const card of cards) {
        expect(card.textContent?.includes('Model')).toBe(agent === 'codex')
        expect(card.textContent).toContain('Permissions')
        expect(card.textContent).toContain('Ask')
        if (agent === 'codex') {
          expect(card.textContent).toContain('saved')
        }
        const controls = Array.from(
          card.querySelectorAll<HTMLButtonElement>('button[role="combobox"].min-w-0')
        )
        expect(controls.length).toBeGreaterThan(0)
        expect(controls.every((control) => control.disabled)).toBe(true)
        expect(card.querySelector('input')?.value).toBe('--saved-cli')
      }
      await act(async () => {
        finish([...detected])
      })
      expect(cards.map((card) => card.textContent)).toEqual(pendingContent)
      for (const card of cards) {
        const controls = Array.from(
          card.querySelectorAll<HTMLButtonElement>('button[role="combobox"].min-w-0')
        )
        expect(controls.length).toBeGreaterThan(0)
        expect(controls.every((control) => !control.disabled)).toBe(true)
        expect(card.textContent?.includes('Model')).toBe(agent === 'codex')
        expect(card.textContent).toContain('Permissions')
        // OpenCode's terminal has no permission flag, so its saved mode reaches chats only.
        expect(card.textContent?.includes('Applies to chats only')).toBe(agent === 'opencode')
        expect(card.textContent).toContain('Extra CLI arguments')
        expect(card.querySelector('input')?.value).toBe('--saved-cli')
        expect(card.querySelector('textarea')?.value).toBe('kept-template')
      }
      expect(JSON.stringify(source.actions.fixCommitFailure)).toBe(originalRecipe)
      expect(writeConfig).not.toHaveBeenCalled()
      expect(onEdit).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, null, '', '--repo'])(
    'renders save controls and argument ownership for %s',
    (repoAgentArgs) => {
      const actionDirtyById = Object.fromEntries(
        SOURCE_CONTROL_ACTION_IDS.map((actionId) => [actionId, actionId === 'fixCommitFailure'])
      ) as Record<SourceControlActionId, boolean>
      const source: SourceControlAiSettings = {
        enabled: true,
        agentId: null,
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        customAgentCommand: '',
        instructionsByOperation: {},
        actions: { fixCommitFailure: { agentId: null, agentArgs: '--global' } }
      }

      const rows = React.createElement(RepositorySourceControlAiActionRows, {
        repoId: 'repo-1',
        repoAi: {
          actionOverrides: {
            fixCommitFailure: {
              agentId: null,
              commandInputTemplate: '{basePrompt}\n\nrepo',
              ...(repoAgentArgs !== undefined ? { agentArgs: repoAgentArgs } : {})
            }
          }
        },
        source,
        defaultTuiAgent: 'codex',
        savingActionIds: {},
        actionDirtyById,
        onActionModeChange: () => {},
        onActionAgentChange: () => {},
        onActionLaunchPreferencesChange: () => {},
        onActionTemplateChange: () => {},
        onActionAgentArgsChange: () => {},
        onAppendVariable: () => {},
        onActionDiscard: () => {},
        onActionSave: () => {}
      })
      const markup = renderToStaticMarkup(React.createElement(TooltipProvider, null, rows))

      expect(markup).toContain('Commit failure fixes')
      expect(markup).toContain('Push failure fixes')
      expect(markup).toContain('Unsaved changes')
      expect(markup).toContain('Discard')
      expect(markup).toContain('Save')
      expect(markup).toContain('repo-repo-1-source-control-ai-fixCommitFailure')
      const card = new DOMParser()
        .parseFromString(markup, 'text/html')
        .getElementById('repo-repo-1-source-control-ai-fixCommitFailure')
      expect(card?.textContent).toContain(
        repoAgentArgs === undefined
          ? 'Global custom args'
          : repoAgentArgs
            ? 'Repository custom args'
            : 'No args'
      )
    }
  )
})

describe('dropRepoLegacyInstructionForAction', () => {
  it('prevents legacy text instructions from remigrating after an action override is cleared', () => {
    const next = dropRepoLegacyInstructionForAction(
      {
        instructionsByOperation: {
          commitMessage: 'Use repo style.',
          pullRequest: 'Use PR style.'
        },
        actionOverrides: {}
      },
      'commitMessage'
    )

    expect(next.instructionsByOperation).toEqual({ pullRequest: 'Use PR style.' })
    const normalized = normalizeRepoSourceControlAiOverrides(next)
    expect(normalized?.actionOverrides?.commitMessage).toBeUndefined()
    expect(normalized?.actionOverrides?.pullRequest).toEqual({
      commandInputTemplate: '{basePrompt}\n\nUse PR style.'
    })
  })

  it('leaves launch action recipes alone because they have no legacy instruction key', () => {
    const value = {
      instructionsByOperation: { commitMessage: 'Use repo style.' },
      actionOverrides: {
        fixChecks: { commandInputTemplate: '{basePrompt}' }
      }
    }

    expect(dropRepoLegacyInstructionForAction(value, 'fixChecks')).toBe(value)
  })
})
