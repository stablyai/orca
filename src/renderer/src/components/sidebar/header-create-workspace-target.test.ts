import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getHeaderCreateWorkspaceTarget } from './header-create-workspace-target'

const localTwin: Repo = {
  id: 'repo-twin',
  path: '/src/twin',
  displayName: 'twin',
  badgeColor: '#000000',
  addedAt: 0
}
const sshTwin: Repo = { ...localTwin, path: '/home/alice/twin', connectionId: 'builder' }

describe('getHeaderCreateWorkspaceTarget', () => {
  it("pins the header's own host when one repo id is registered on two hosts", () => {
    expect(getHeaderCreateWorkspaceTarget(sshTwin, [localTwin, sshTwin], [])).toMatchObject({
      initialWorkspaceTarget: { hostId: 'ssh:builder' }
    })
  })

  it('leaves a uniquely registered checkout to the id path, which names that exact checkout', () => {
    const second: Repo = { ...localTwin, id: 'repo-second', path: '/src/twin-second' }

    expect(getHeaderCreateWorkspaceTarget(second, [localTwin, second], [])).toEqual({})
  })

  it('leaves a recipe VM header to the id path that maps it to an eligible sibling', () => {
    const recipeVm: Repo = { ...localTwin, connectionId: 'runtime-ssh-vm-1' }

    expect(getHeaderCreateWorkspaceTarget(recipeVm, [localTwin, recipeVm], [])).toEqual({})
  })
})
