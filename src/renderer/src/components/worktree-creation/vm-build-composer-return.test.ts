import { describe, expect, it } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { composerDataFromRefusedCreate, typedComposerPrompt } from './vm-build-composer-return'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields read here.
const request = {
  repoId: 'repo-1',
  name: 'otter',
  displayName: 'Fix login',
  displayNameKind: 'user',
  baseBranch: 'main',
  agent: 'claude',
  note: 'Fix the login redirect',
  telemetrySource: 'sidebar',
  ephemeralVmRecipe: {
    sourceRepoId: 'repo-1',
    recipeId: 'cloud',
    projectId: 'p',
    provider: 'orca-cloud'
  }
} as unknown as WorktreeCreationRequest

describe('composer data for a create billing refused', () => {
  it('restores the typed prompt and keeps Orca Cloud on Dismiss', () => {
    expect(composerDataFromRefusedCreate({ request }, { local: false })).toEqual({
      initialRepoId: 'repo-1',
      initialEphemeralVmRecipeId: 'cloud',
      prefilledName: 'Fix login',
      initialBaseBranch: 'main',
      recovery: { note: 'Fix the login redirect', agent: 'claude' },
      telemetrySource: 'sidebar'
    })
  })

  it('drops the sandbox for Create on this computer instead', () => {
    const data = composerDataFromRefusedCreate({ request }, { local: true })
    expect(data.initialEphemeralVmRecipeId).toBeUndefined()
    expect(data.recovery?.note).toBe('Fix the login redirect')
  })

  it('prefers a prompt queued during the build and never restores a generated name', () => {
    const entry = {
      heldChatMessage: 'Queued instead',
      request: { ...request, displayNameKind: 'generated' as const }
    }
    expect(typedComposerPrompt(entry)).toBe('Queued instead')
    expect(composerDataFromRefusedCreate(entry, { local: true }).prefilledName).toBeUndefined()
  })
})
