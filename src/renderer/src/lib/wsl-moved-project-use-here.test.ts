import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import type {
  WslMovedProject,
  WslMoveUseLocallyResult
} from '../../../shared/wsl-move/wsl-moved-project'

const movedProjects = vi.hoisted((): { kind: string; id: string; displayName: string }[] => [])
const openFiles = vi.hoisted(
  (): { id: string; relativePath: string; worktreeId: string; isDirty: boolean }[] => []
)
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ wslMovedProjects: movedProjects, openFiles }) }
}))

const { bringWslMovedProjectBack } = await import('./wsl-moved-project-use-here')

const project: WslMovedProject = {
  kind: 'repo',
  id: 'repo-1',
  displayName: 'Repo 1',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1',
  distro: 'Ubuntu'
}

function stubApi(result: WslMoveUseLocallyResult): ReturnType<typeof vi.fn> {
  const useProjectHereAgain = vi.fn(async () => result)
  vi.stubGlobal('window', { api: { wslMove: { useProjectHereAgain } } })
  return useProjectHereAgain
}

describe('bringWslMovedProjectBack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openFiles.length = 0
  })

  // P6's unsaved README blocked bringing p9 back; only the move's own files count.
  it("asks for the move's unsaved files to be saved first, naming only those", async () => {
    openFiles.push(
      { id: 'f1', relativePath: 'README.md', worktreeId: 'repo-1::/w', isDirty: true },
      { id: 'f2', relativePath: 'other.md', worktreeId: 'repo-2::/w', isDirty: true },
      { id: 'f3', relativePath: 'saved.md', worktreeId: 'repo-3::/w', isDirty: false }
    )
    const call = stubApi({
      released: false,
      reason: 'unsaved-files',
      unsavedWorkspaceIds: ['repo-1::/w']
    })
    const confirm = vi.fn(async (_options: ConfirmationDialogOptions) => true)
    await bringWslMovedProjectBack(project, confirm)
    expect(call).toHaveBeenCalledWith({
      kind: 'repo',
      id: 'repo-1',
      unsavedWorkspaceIds: ['repo-1::/w', 'repo-2::/w']
    })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1]?.[0]).toMatchObject({ acknowledgeOnly: true })
    expect(confirm.mock.calls[1]?.[0]?.description).toContain('README.md')
    expect(confirm.mock.calls[1]?.[0]?.description).not.toContain('other.md')
  })

  it('does nothing unless the user confirms', async () => {
    const call = stubApi({ released: false, reason: 'not-moved' })
    await bringWslMovedProjectBack(project, async () => false)
    expect(call).not.toHaveBeenCalled()
  })
})
