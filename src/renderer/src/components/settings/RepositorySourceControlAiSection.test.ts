import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import {
  createRepoAiDraftState,
  dropRepoLegacyInstructionForAction,
  resolveRepoAiDraftState
} from './RepositorySourceControlAiSection'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'

describe('RepositorySourceControlAiSection draft state', () => {
  it('refreshes clean drafts when persisted repo overrides change', () => {
    const state = createRepoAiDraftState('repo-1', {
      instructionsByOperation: {
        commitMessage: 'old'
      }
    })
    const persisted: RepoSourceControlAiOverrides = {
      instructionsByOperation: {
        commitMessage: 'new'
      }
    }

    expect(resolveRepoAiDraftState(state, 'repo-1', persisted)).toEqual({
      repoId: 'repo-1',
      value: persisted,
      baseSerialized: JSON.stringify(normalizeRepoSourceControlAiOverrides(persisted))
    })
  })

  it('preserves dirty drafts across external repo override changes', () => {
    const state = createRepoAiDraftState('repo-1', {
      instructionsByOperation: {
        commitMessage: 'old'
      }
    })
    state.value = {
      instructionsByOperation: {
        commitMessage: 'local edit'
      }
    }

    const persisted: RepoSourceControlAiOverrides = {
      instructionsByOperation: {
        commitMessage: 'external edit'
      }
    }

    expect(resolveRepoAiDraftState(state, 'repo-1', persisted)).toBe(state)
  })

  it('resets the draft when the selected repo changes', () => {
    const state = createRepoAiDraftState('repo-1', {
      prCreationDefaults: {
        draft: true
      }
    })
    state.value = {
      prCreationDefaults: {
        draft: false
      }
    }

    const persisted: RepoSourceControlAiOverrides = {
      prCreationDefaults: {
        useTemplate: true
      }
    }

    expect(resolveRepoAiDraftState(state, 'repo-2', persisted)).toEqual({
      repoId: 'repo-2',
      value: persisted,
      baseSerialized: JSON.stringify(normalizeRepoSourceControlAiOverrides(persisted))
    })
  })
})

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
