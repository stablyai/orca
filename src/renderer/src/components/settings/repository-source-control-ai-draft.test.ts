import { describe, expect, it } from 'vitest'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { buildActionScopedRepoAiSave } from './repository-source-control-ai-draft'

describe('buildActionScopedRepoAiSave', () => {
  it('persists only the target action, keeping siblings at their saved values', () => {
    const persisted: RepoSourceControlAiOverrides = {
      actionOverrides: {
        resolveConflicts: {
          agentId: 'claude',
          commandInputTemplate: '{basePrompt}',
          agentArgs: ''
        },
        fixCommitFailure: { agentId: 'codex', commandInputTemplate: '{basePrompt}', agentArgs: '' }
      }
    }
    const draft: RepoSourceControlAiOverrides = {
      actionOverrides: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}\n\nedited',
          agentArgs: ''
        },
        // A half-finished edit on a different row that must NOT be flushed.
        fixCommitFailure: {
          agentId: 'gemini',
          commandInputTemplate: '{basePrompt}\n\nunsaved',
          agentArgs: ''
        }
      }
    }

    const next = buildActionScopedRepoAiSave(persisted, draft, 'resolveConflicts')

    expect(next.actionOverrides?.resolveConflicts?.agentId).toBe('codex')
    expect(next.actionOverrides?.resolveConflicts?.commandInputTemplate).toBe(
      '{basePrompt}\n\nedited'
    )
    // Sibling keeps the persisted value, not the draft's pending edit.
    expect(next.actionOverrides?.fixCommitFailure?.agentId).toBe('codex')
    expect(next.actionOverrides?.fixCommitFailure?.commandInputTemplate).toBe('{basePrompt}')
  })

  it('removes the action override when the draft inherits it', () => {
    const persisted: RepoSourceControlAiOverrides = {
      actionOverrides: {
        resolveConflicts: { agentId: 'claude', commandInputTemplate: '{basePrompt}', agentArgs: '' }
      }
    }
    const draft: RepoSourceControlAiOverrides = { actionOverrides: {} }

    const next = buildActionScopedRepoAiSave(persisted, draft, 'resolveConflicts')

    expect(next.actionOverrides?.resolveConflicts).toBeUndefined()
  })
})
