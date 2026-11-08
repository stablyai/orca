import { describe, expect, it } from 'vitest'
import { resolveInitialWorkspaceRunSeed } from './composer-state/composer-decisions'

describe('useComposerState host-context boundaries', () => {
  it('uses an explicit creation target without borrowing the linked Jira account host', () => {
    expect(
      resolveInitialWorkspaceRunSeed({
        initialTaskSourceContext: {
          projectId: 'account-backed-task-source',
          hostId: 'local',
          projectHostSetupId: 'unrelated-setup'
        },
        initialWorkspaceTarget: { projectId: 'mapped-project', hostId: 'ssh:builder' }
      })
    ).toEqual({ projectId: 'mapped-project', hostId: 'ssh:builder', projectHostSetupId: null })
  })
})
