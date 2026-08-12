import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWebSessionBrowserPlacementsForEnvironment,
  clearWebSessionBrowserPlacementsForWorktree,
  forgetWebSessionBrowserPlacement,
  isWebSessionBrowserPlacementGroupReserved,
  recordWebSessionBrowserPlacement,
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
        environmentId: ENVIRONMENT_ID,
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
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        groupId: 'preview-group'
      })
    ).toBe(false)
  })

  it('bounds pending page placements', () => {
    for (let index = 0; index < 129; index += 1) {
      recordWebSessionBrowserPlacement({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: `page-${index}`,
        groupId: `group-${index}`
      })
    }

    expect(
      takeWebSessionBrowserPlacementGroup({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        remotePageId: 'page-0'
      })
    ).toBeUndefined()
    expect(
      isWebSessionBrowserPlacementGroupReserved({
        environmentId: ENVIRONMENT_ID,
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
    ).toBe('group-128')
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
        environmentId: ENVIRONMENT_ID,
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
