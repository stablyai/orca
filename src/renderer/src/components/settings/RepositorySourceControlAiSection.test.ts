import { describe, expect, it } from 'vitest'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { createRepoAiDraftState, resolveRepoAiDraftState } from './RepositorySourceControlAiSection'

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
      baseSerialized: JSON.stringify(persisted)
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
      baseSerialized: JSON.stringify(persisted)
    })
  })
})
