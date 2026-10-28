import { describe, expect, it } from 'vitest'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import { wslMovedProjectForAutomation } from './wsl-moved-projects'

const repo: WslMovedProject = {
  kind: 'repo',
  id: 'repo-1',
  displayName: 'Repo 1',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1',
  distro: 'Ubuntu'
}
const folder: WslMovedProject = { ...repo, kind: 'folder', id: 'folder-1', distro: 'Debian' }

describe("a local automation's moved project", () => {
  it("names a moved repo's or folder's local automations", () => {
    expect(
      wslMovedProjectForAutomation([repo, folder], {
        executionTargetType: 'local',
        projectId: 'repo-1',
        workspaceId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1'
      })
    ).toBe(repo)
    expect(
      wslMovedProjectForAutomation([repo, folder], {
        executionTargetType: 'local',
        projectId: 'folder-project',
        workspaceId: 'folder:folder-1'
      })
    ).toBe(folder)
  })

  it('names nothing for another project, or for an automation that runs elsewhere', () => {
    expect(
      wslMovedProjectForAutomation([repo], { executionTargetType: 'local', projectId: 'repo-2' })
    ).toBeNull()
    expect(
      wslMovedProjectForAutomation([repo], { executionTargetType: 'ssh', projectId: 'repo-1' })
    ).toBeNull()
    expect(
      wslMovedProjectForAutomation([], { executionTargetType: 'local', projectId: 'repo-1' })
    ).toBeNull()
  })
})
