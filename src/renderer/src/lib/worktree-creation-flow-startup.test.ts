import { describe, expect, it } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { buildHostDraftStartupOptions } from './worktree-creation-flow-startup'

const request = {
  agent: 'codex',
  launchDraftPrompt: 'https://github.com/stablyai/orca/issues/12',
  startupPlan: {
    sessionOptions: { model: 'gpt-5.6-sol', effort: 'high' }
  }
} as unknown as WorktreeCreationRequest

describe('buildHostDraftStartupOptions', () => {
  it('scopes launch options to the requested agent', () => {
    expect(buildHostDraftStartupOptions(request, false)).toEqual({
      startupDraft: request.launchDraftPrompt,
      startupSessionOptions: {
        agent: 'codex',
        values: { model: 'gpt-5.6-sol', effort: 'high' }
      }
    })
  })

  it('omits host-owned startup when the client already built it', () => {
    expect(buildHostDraftStartupOptions(request, true)).toEqual({})
  })
})
