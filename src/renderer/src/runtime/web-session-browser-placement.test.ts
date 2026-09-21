import { afterEach, describe, expect, it } from 'vitest'
import {
  claimWebSessionBrowserPlacementGroupCleanup,
  clearWebSessionBrowserPlacementsForEnvironment,
  clearWebSessionBrowserPlacementsForWorktree,
  forgetWebSessionBrowserPlacement,
  isWebSessionBrowserPlacementGroupReserved,
  markWebSessionBrowserPlacementAdopted,
  moveWebSessionBrowserPlacement,
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

  /**
   * A record survives adoption because the group it named is still reserved against cleanup, so
   * every later write to that entry has to carry the spent intent with it. Nothing in the create
   * flow can reach these two paths today — the mark needs the host to publish the provisional id,
   * and the move only fires when it mints a different one — but the module is what promises the
   * three states stay consistent, not the order its callers happen to run in.
   */
  describe('a create intent the host already spent', () => {
    function recordAdoptedPage(remotePageId: string): void {
      recordWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId,
        groupId: 'preview-group',
        callerCreatedGroup: true
      })
      markWebSessionBrowserPlacementAdopted({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId
      })
    }

    it('stays spent when the create rehomes onto a host-minted page id', () => {
      recordAdoptedPage('provisional-page')

      moveWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        fromRemotePageId: 'provisional-page',
        toRemotePageId: 'host-page'
      })

      expect(
        peekWebSessionBrowserPlacementGroup({
          environmentId: ENVIRONMENT_ID,
          worktreeId: WORKTREE_ID,
          remotePageId: 'host-page'
        })
      ).toBeUndefined()
      expect(
        isWebSessionBrowserPlacementGroupReserved({
          worktreeId: WORKTREE_ID,
          groupId: 'preview-group'
        })
      ).toBe(true)
    })

    it('stays spent when the same page is recorded again', () => {
      recordAdoptedPage('page-1')

      recordWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-1',
        groupId: 'preview-group'
      })

      expect(
        peekWebSessionBrowserPlacementGroup({
          environmentId: ENVIRONMENT_ID,
          worktreeId: WORKTREE_ID,
          remotePageId: 'page-1'
        })
      ).toBeUndefined()
    })

    // Why re-marking is worth its own case: the mark runs on every snapshot for every published
    // page, so the second one is the common case, not an edge. A mark that rewrote the entry
    // instead of amending it would drop the group reservation the entry is being kept alive for.
    it('keeps its group and its cleanup claim when a later snapshot marks it again', () => {
      recordAdoptedPage('page-1')
      markWebSessionBrowserPlacementAdopted({
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
      expect(
        releaseWebSessionBrowserPlacementGroup({
          environmentId: ENVIRONMENT_ID,
          worktreeId: WORKTREE_ID,
          remotePageId: 'page-1',
          groupId: 'preview-group',
          callerCreatedGroup: false
        })
      ).toBe(true)
    })
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
