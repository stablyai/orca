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

  it('drops the sandbox for Use this computer instead', () => {
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

describe('Back to draft from a GitHub-only create (GH-CREATE-SHEET)', () => {
  const github = {
    ...request,
    repoId: '',
    note: '',
    githubSource: {
      repoUrl: 'https://github.com/acme/web',
      fullName: 'acme/web',
      prompt: 'Fix login',
      composerRepoId: 'repo-1'
    }
  }

  it('reopens the composer on Orca Cloud with the GitHub repository picked and the prompt kept', () => {
    expect(typedComposerPrompt({ request: github })).toBe('Fix login')
    expect(composerDataFromRefusedCreate({ request: github }, { local: false })).toEqual({
      initialRepoId: 'repo-1',
      initialEphemeralVmRecipeId: 'cloud',
      initialCloudGitHubRepo: 'acme/web',
      prefilledName: 'Fix login',
      recovery: { note: '', agent: 'claude' },
      telemetrySource: 'sidebar'
    })
  })

  it('"Create locally" keeps the composer’s own project, with no cloud repository', () => {
    expect(composerDataFromRefusedCreate({ request: github }, { local: true })).toEqual({
      initialRepoId: 'repo-1',
      prefilledName: 'Fix login',
      recovery: { note: '', agent: 'claude' },
      telemetrySource: 'sidebar'
    })
  })
})
