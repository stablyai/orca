import { afterEach, describe, expect, it } from 'vitest'
import {
  claimWebSessionBrowserPlacementGroupCleanup,
  clearWebSessionBrowserPlacementsForEnvironment,
  clearWebSessionBrowserPlacementsForWorktree,
  forgetWebSessionBrowserPlacement,
  isWebSessionBrowserPlacementGroupReserved,
  peekWebSessionBrowserPlacementGroup,
  recordWebSessionBrowserPlacement,
  releaseWebSessionBrowserPlacementGroup,
  resetWebSessionBrowserPlacementsForTests,
  takeWebSessionBrowserPlacementGroup
} from './web-session-browser-placement'

const ENVIRONMENT_ID = 'environment-1'
const WORKTREE_ID = 'worktree-1'

afterEach(resetWebSessionBrowserPlacementsForTests)

describe('web session browser placement', () => {
  it('keeps a shared target group reserved until every pending page settles', () => {
    for (const remotePageId of ['page-1', 'page-2']) {
      recordWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId,
        groupId: 'preview-group'
      })
    }

    forgetWebSessionBrowserPlacement({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-1'
    })
    expect(
      isWebSessionBrowserPlacementGroupReserved({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group'
      })
    ).toBe(true)

    forgetWebSessionBrowserPlacement({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-2'
    })
    expect(
      isWebSessionBrowserPlacementGroupReserved({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group'
      })
    ).toBe(false)
  })

  it('transfers caller-created group cleanup to the last failed reservation', () => {
    recordWebSessionBrowserPlacement({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-1',
      groupId: 'preview-group',
      callerCreatedGroup: true
    })
    recordWebSessionBrowserPlacement({
      environmentId: 'environment-2',
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-2',
      groupId: 'preview-group'
    })

    const creatorOwnsCleanup = releaseWebSessionBrowserPlacementGroup({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-1',
      groupId: 'preview-group',
      callerCreatedGroup: true
    })
    expect(
      claimWebSessionBrowserPlacementGroupCleanup({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group',
        ownsGroupCleanup: creatorOwnsCleanup
      })
    ).toBe(false)
    const followerOwnsCleanup = releaseWebSessionBrowserPlacementGroup({
      environmentId: 'environment-2',
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-2',
      groupId: 'preview-group',
      callerCreatedGroup: false
    })
    expect(
      claimWebSessionBrowserPlacementGroupCleanup({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group',
        ownsGroupCleanup: followerOwnsCleanup
      })
    ).toBe(true)
  })

  it('retains transferred cleanup when one overlapping environment clears', () => {
    for (const [environmentId, remotePageId, callerCreatedGroup] of [
      [ENVIRONMENT_ID, 'page-1', true],
      ['environment-2', 'page-2', false],
      ['environment-3', 'page-3', false]
    ] as const) {
      recordWebSessionBrowserPlacement({
        environmentId,
        worktreeId: WORKTREE_ID,
        remotePageId,
        groupId: 'preview-group',
        callerCreatedGroup
      })
    }
    const ownsCleanup = releaseWebSessionBrowserPlacementGroup({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-1',
      groupId: 'preview-group',
      callerCreatedGroup: true
    })
    expect(
      claimWebSessionBrowserPlacementGroupCleanup({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group',
        ownsGroupCleanup: ownsCleanup
      })
    ).toBe(false)

    clearWebSessionBrowserPlacementsForEnvironment('environment-2')
    const remainingOwnsCleanup = releaseWebSessionBrowserPlacementGroup({
      environmentId: 'environment-3',
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-3',
      groupId: 'preview-group',
      callerCreatedGroup: false
    })
    expect(remainingOwnsCleanup).toBe(true)
    expect(
      claimWebSessionBrowserPlacementGroupCleanup({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group',
        ownsGroupCleanup: remainingOwnsCleanup
      })
    ).toBe(false)
    const clearedEnvironmentOwnsCleanup = releaseWebSessionBrowserPlacementGroup({
      environmentId: 'environment-2',
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-2',
      groupId: 'preview-group',
      callerCreatedGroup: false
    })
    expect(
      claimWebSessionBrowserPlacementGroupCleanup({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group',
        ownsGroupCleanup: clearedEnvironmentOwnsCleanup
      })
    ).toBe(true)
  })

  it('retains transferred cleanup through snapshot placement lookup', () => {
    recordWebSessionBrowserPlacement({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-1',
      groupId: 'preview-group',
      callerCreatedGroup: true
    })
    recordWebSessionBrowserPlacement({
      environmentId: 'environment-2',
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-2',
      groupId: 'preview-group'
    })
    const ownsCleanup = releaseWebSessionBrowserPlacementGroup({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-1',
      groupId: 'preview-group',
      callerCreatedGroup: true
    })
    expect(
      claimWebSessionBrowserPlacementGroupCleanup({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group',
        ownsGroupCleanup: ownsCleanup
      })
    ).toBe(false)

    expect(
      peekWebSessionBrowserPlacementGroup({
        environmentId: 'environment-2',
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-2'
      })
    ).toBe('preview-group')
    expect(
      releaseWebSessionBrowserPlacementGroup({
        environmentId: 'environment-2',
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-2',
        groupId: 'preview-group',
        callerCreatedGroup: false
      })
    ).toBe(true)
  })

  it.each(['environment', 'worktree'] as const)(
    'retains transferred cleanup through %s teardown',
    (scope) => {
      recordWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-1',
        groupId: 'preview-group',
        callerCreatedGroup: true
      })
      recordWebSessionBrowserPlacement({
        environmentId: 'environment-2',
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-2',
        groupId: 'preview-group'
      })
      const ownsCleanup = releaseWebSessionBrowserPlacementGroup({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-1',
        groupId: 'preview-group',
        callerCreatedGroup: true
      })
      claimWebSessionBrowserPlacementGroupCleanup({
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group',
        ownsGroupCleanup: ownsCleanup
      })

      if (scope === 'environment') {
        clearWebSessionBrowserPlacementsForEnvironment('environment-2')
      } else {
        clearWebSessionBrowserPlacementsForWorktree('environment-2', WORKTREE_ID)
      }

      expect(
        releaseWebSessionBrowserPlacementGroup({
          environmentId: 'environment-2',
          worktreeId: WORKTREE_ID,
          remotePageId: 'page-2',
          groupId: 'preview-group',
          callerCreatedGroup: false
        })
      ).toBe(true)
    }
  )

  it('bounds pending page placements', () => {
    for (let index = 0; index < 128; index += 1) {
      recordWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: `page-${index}`,
        groupId: `group-${index}`
      })
    }

    expect(() =>
      recordWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-128',
        groupId: 'group-128'
      })
    ).toThrow('Too many paired browser placements are pending')

    expect(
      takeWebSessionBrowserPlacementGroup({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-0'
      })
    ).toBe('group-0')
    expect(
      isWebSessionBrowserPlacementGroupReserved({
        worktreeId: WORKTREE_ID,
        groupId: 'group-0'
      })
    ).toBe(false)
    expect(
      takeWebSessionBrowserPlacementGroup({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-128'
      })
    ).toBeUndefined()
  })

  it('refreshes existing entries at capacity without evicting another placement', () => {
    for (let index = 0; index < 128; index += 1) {
      recordWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: `page-${index}`,
        groupId: `group-${index}`
      })
    }

    recordWebSessionBrowserPlacement({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      remotePageId: 'page-127',
      groupId: 'group-127'
    })

    expect(
      isWebSessionBrowserPlacementGroupReserved({
        worktreeId: WORKTREE_ID,
        groupId: 'group-0'
      })
    ).toBe(true)
    expect(
      takeWebSessionBrowserPlacementGroup({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-0'
      })
    ).toBe('group-0')
  })

  it('clears only the requested worktree or environment', () => {
    for (const [environmentId, worktreeId, suffix] of [
      [ENVIRONMENT_ID, WORKTREE_ID, 'target'],
      [ENVIRONMENT_ID, 'worktree-2', 'sibling'],
      ['environment-2', WORKTREE_ID, 'other-environment']
    ] as const) {
      recordWebSessionBrowserPlacement({
        environmentId,
        worktreeId,
        remotePageId: `page-${suffix}`,
        groupId: `group-${suffix}`
      })
    }

    clearWebSessionBrowserPlacementsForWorktree(ENVIRONMENT_ID, WORKTREE_ID)

    expect(
      takeWebSessionBrowserPlacementGroup({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-target'
      })
    ).toBeUndefined()
    expect(
      takeWebSessionBrowserPlacementGroup({
        environmentId: ENVIRONMENT_ID,
        worktreeId: 'worktree-2',
        remotePageId: 'page-sibling'
      })
    ).toBe('group-sibling')

    clearWebSessionBrowserPlacementsForEnvironment('environment-2')

    expect(
      takeWebSessionBrowserPlacementGroup({
        environmentId: 'environment-2',
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-other-environment'
      })
    ).toBeUndefined()
  })
})
