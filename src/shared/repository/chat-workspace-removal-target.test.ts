import { expect, it } from 'vitest'
import type { Repo } from './repo-types'
import { chatWorkspaceRemovalTarget } from './chat-workspace-removal-target'

type SectionRepo = Pick<Repo, 'id' | 'displayName' | 'path' | 'chatWorkspace' | 'executionHostId'>

it('limits Chat project removal to the declared owner and root', () => {
  const chat: SectionRepo = {
    id: 'same-id',
    displayName: 'Chat',
    path: '/chats/one',
    executionHostId: 'local',
    chatWorkspace: { initialName: 'New project-20261125', autoName: true }
  }
  const ordinary: SectionRepo = {
    id: 'same-id',
    displayName: 'Project',
    path: '/chats/one',
    executionHostId: 'local'
  }
  const row = {
    repoId: 'same-id',
    path: '/chats/one',
    isMainWorktree: true,
    hostId: 'local' as const
  }
  const remote: SectionRepo = { ...chat, executionHostId: 'runtime:server' }
  expect(chatWorkspaceRemovalTarget(row, [ordinary, remote])).toBeNull()
  expect(chatWorkspaceRemovalTarget(row, [chat, remote])).toEqual({
    repo: 'id:same-id',
    repoHostId: 'local'
  })
  expect(
    chatWorkspaceRemovalTarget({ ...row, hostId: 'runtime:server' }, [ordinary, remote])
  ).toEqual({ repo: 'id:same-id', repoHostId: 'local' })
  expect(
    chatWorkspaceRemovalTarget({ ...row, hostId: 'ssh:node' }, [
      ordinary,
      { ...chat, executionHostId: 'ssh:node' }
    ])
  ).toEqual({ repo: 'id:same-id', repoHostId: 'ssh:node' })
  expect(chatWorkspaceRemovalTarget({ ...row, hostId: undefined }, [chat, remote])).toBeNull()
  expect(chatWorkspaceRemovalTarget({ ...row, isMainWorktree: false }, [chat])).toBeNull()
  expect(chatWorkspaceRemovalTarget({ ...row, path: '/chats/one/child' }, [chat])).toBeNull()
})
