// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT } from '../../workspace-creator-visibility'
import { repo as baseRepo } from '../../worktree-list-groups-test-fixtures'
import { useSidebarHostVisibleScope } from './use-host-visible-scope'

function group(id: string, parentGroupId: string | null = null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function repo(id: string, projectGroupId: string | null): Repo {
  return { ...baseRepo, id, displayName: id, path: `/repos/${id}`, projectGroupId }
}

const platform = group('platform')
const platformApi = group('platform-api', 'platform')
const tooling = group('tooling')
const projectGroups = [platform, platformApi, tooling]
const repos = [repo('api', 'platform-api'), repo('cli', 'tooling')]

function render(filterRepoIds: readonly string[]) {
  return renderHook(() =>
    useSidebarHostVisibleScope({
      filterState: {
        showSleepingWorkspaces: true,
        filterRepoIds,
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        alwaysShowDefaultBranchWorkspace: true,
        visibleWorkspaceHostIds: null,
        workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE
      },
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      repos,
      projectGroups,
      folderWorkspaces: [],
      pairedDeviceIdsByEnvironment: EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT
    })
  )
}

describe('useSidebarHostVisibleScope project filter', () => {
  afterEach(() => {
    cleanup()
  })

  it('keeps every project group when no project filter is active', () => {
    const { result } = render([])
    expect(result.current.visibleProjectGroupsForRows).toBe(projectGroups)
  })

  it('hides project groups the project filter leaves empty, keeping ancestors', () => {
    const { result } = render(['api'])
    expect(result.current.visibleProjectGroupsForRows).toEqual([platform, platformApi])
  })
})
