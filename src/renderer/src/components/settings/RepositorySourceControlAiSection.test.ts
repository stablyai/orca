import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import {
  SOURCE_CONTROL_ACTION_IDS,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import { dropRepoLegacyInstructionForAction } from './repository-source-control-ai-draft'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'

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
  it('renders save controls on dirty repository action recipes', () => {
    const actionDirtyById = Object.fromEntries(
      SOURCE_CONTROL_ACTION_IDS.map((actionId) => [actionId, actionId === 'fixCommitFailure'])
    ) as Record<SourceControlActionId, boolean>
    const source = {
      enabled: true,
      agentId: null,
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customAgentCommand: '',
      instructionsByOperation: {}
    } as SourceControlAiSettings

    const markup = renderToStaticMarkup(
      React.createElement(RepositorySourceControlAiActionRows, {
        repoId: 'repo-1',
        repoAi: {
          actionOverrides: {
            fixCommitFailure: {
              agentId: null,
              commandInputTemplate: '{basePrompt}\n\nrepo'
            }
          }
        },
        source,
        defaultTuiAgent: 'codex',
        savingActionIds: {},
        actionDirtyById,
        onActionModeChange: () => {},
        onActionAgentChange: () => {},
        onActionTemplateChange: () => {},
        onActionAgentArgsChange: () => {},
        onAppendVariable: () => {},
        onActionDiscard: () => {},
        onActionSave: () => {}
      })
    )

    expect(markup).toContain('Commit failure fixes')
    expect(markup).toContain('Push failure fixes')
    expect(markup).toContain('Unsaved changes')
    expect(markup).toContain('Discard')
    expect(markup).toContain('Save')
    expect(markup).toContain('repo-repo-1-source-control-ai-fixCommitFailure')
  })
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
