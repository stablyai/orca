import { describe, expect, it } from 'vitest'
import { buildComposerReopenData } from './use-machine-sign-in-restore'

describe('buildComposerReopenData', () => {
  it('reopens on what was picked and typed, over what the composer opened with', () => {
    expect(
      buildComposerReopenData(
        { initialRepoId: 'repo-1', telemetrySource: 'sidebar' },
        {
          name: 'fix-auth',
          projectId: 'project-1',
          hostId: 'runtime:env-1',
          projectHostSetupId: 'setup-2',
          ephemeralVmRecipeId: null
        }
      )
    ).toEqual({
      initialRepoId: 'repo-1',
      telemetrySource: 'sidebar',
      prefilledName: 'fix-auth',
      initialWorkspaceTarget: {
        projectId: 'project-1',
        hostId: 'runtime:env-1',
        projectHostSetupId: 'setup-2'
      }
    })
  })
})
