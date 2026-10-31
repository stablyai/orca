import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { selectProjectGroupRemovalTargets } from './project-group-removal-targets'

const rootGroup: ProjectGroup = {
  id: 'root',
  name: 'Root',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const childGroup: ProjectGroup = {
  ...rootGroup,
  id: 'child',
  name: 'Child',
  parentGroupId: rootGroup.id,
  tabOrder: 1
}

const siblingGroup: ProjectGroup = {
  ...rootGroup,
  id: 'sibling',
  name: 'Sibling',
  tabOrder: 2
}

function makeRepo(id: string, projectGroupId: string | null): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    projectGroupId
  }
}

describe('selectProjectGroupRemovalTargets', () => {
  it('selects direct and nested child projects in repo order', () => {
    const result = selectProjectGroupRemovalTargets(
      [rootGroup, childGroup, siblingGroup],
      [
        makeRepo('direct', rootGroup.id),
        makeRepo('nested', childGroup.id),
        makeRepo('sibling', siblingGroup.id),
        makeRepo('ungrouped', null)
      ],
      rootGroup.id
    )

    expect(result.groupExists).toBe(true)
    expect([...result.deletedGroupIds].sort()).toEqual([childGroup.id, rootGroup.id])
    expect(result.projectIds).toEqual(['direct', 'nested'])
  })

  it('returns an empty project list for empty groups', () => {
    const result = selectProjectGroupRemovalTargets([rootGroup], [], rootGroup.id)

    expect(result.groupExists).toBe(true)
    expect([...result.deletedGroupIds]).toEqual([rootGroup.id])
    expect(result.projectIds).toEqual([])
  })

  it('does not synthesize targets for a missing group', () => {
    const result = selectProjectGroupRemovalTargets(
      [rootGroup],
      [makeRepo('direct', rootGroup.id)],
      'missing'
    )

    expect(result.groupExists).toBe(false)
    expect([...result.deletedGroupIds]).toEqual([])
    expect(result.projectIds).toEqual([])
  })
})

import * as launchDrafts from '@/components/native-chat/native-chat-composer-draft-store'
import { makeFolderWorkspace } from './worktrees-slice-test-fixtures'
import { createTestStore } from './store-test-helpers'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
const groupedRepo = makeRepo('grouped', rootGroup.id)
const rootGroupsDelete = vi.fn()

it('committed group cascade retires actual dropped folders added during RPC, keeping ungrouped repos and other-host copies', async () => {
  launchDrafts.clearNativeChatComposerDraftsForTests()
  const reply = Promise.withResolvers<boolean>()
  rootGroupsDelete.mockReturnValue(reply.promise)
  vi.stubGlobal('window', { api: { projectGroups: { delete: rootGroupsDelete } } })
  const store = createTestStore()
  store.setState({
    projectGroups: [{ ...rootGroup, executionHostId: 'local' }],
    repos: [{ ...groupedRepo, executionHostId: 'local', projectGroupId: rootGroup.id }]
  })
  const deleting = store.getState().deleteProjectGroup(rootGroup.id, { hostId: 'local' })
  await vi.waitFor(() => expect(rootGroupsDelete).toHaveBeenCalledOnce())
  const folder = makeFolderWorkspace({
    id: 'late-folder',
    projectGroupId: rootGroup.id,
    executionHostId: 'local'
  })
  store.setState({ folderWorkspaces: [folder, { ...folder, executionHostId: 'runtime:other' }] })
  const gone = launchDrafts.nativeChatLaunchPromptDraftScopeKey(
    folderWorkspaceKey(folder.id),
    'claude',
    'local'
  )
  const controls = [
    launchDrafts.nativeChatLaunchPromptDraftScopeKey(
      folderWorkspaceKey(folder.id),
      'claude',
      'runtime:other'
    ),
    launchDrafts.nativeChatLaunchPromptDraftScopeKey(`${groupedRepo.id}::/live`, 'codex', 'local')
  ]
  for (const key of [gone, ...controls]) {
    launchDrafts.updateNativeChatComposerDraft(key, { text: 'task' }, 'immediate')
  }
  const attempt = launchDrafts.captureNativeChatComposerSubmission(gone)
  reply.resolve(false)
  expect(await deleting).toBe(false)
  expect(attempt.draft?.text).toBe('task')
  rootGroupsDelete.mockResolvedValue(true)
  expect(await store.getState().deleteProjectGroup(rootGroup.id, { hostId: 'local' })).toBe(true)
  expect(attempt.draft).toBeUndefined()
  expect(store.getState().folderWorkspaces).toEqual([
    { ...folder, executionHostId: 'runtime:other' }
  ])
  expect(store.getState().repos[0].projectGroupId).toBeNull()
  controls.forEach((key) => expect(launchDrafts.readNativeChatComposerDraft(key).text).toBe('task'))
  launchDrafts.clearNativeChatComposerDraftsForTests()
  vi.unstubAllGlobals()
})
