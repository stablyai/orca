import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import type {
  WslMovedProject,
  WslMoveUseLocallyResult
} from '../../../shared/wsl-move/wsl-moved-project'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

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
  })

  it('does nothing unless the user confirms', async () => {
    const call = stubApi({ released: false, reason: 'not-moved' })
    await bringWslMovedProjectBack(project, async () => false)
    expect(call).not.toHaveBeenCalled()
  })

  it('says plainly what comes back and what stays on the host', async () => {
    stubApi({ released: false, reason: 'not-moved' })
    const confirm = vi.fn(async (_options: ConfirmationDialogOptions) => false)
    await bringWslMovedProjectBack(project, confirm)
    const description = confirm.mock.calls[0]?.[0]?.description ?? ''
    expect(description).toContain('Your code is not affected')
    expect(description).toContain('stay on the host and do not come back')
    expect(description).toContain('stays on the Ubuntu host until you remove it there')
    expect(description).toContain('This window reloads')
  })

  it('asks main to bring the project back, and says nothing more on success', async () => {
    const call = stubApi({
      released: true,
      distro: 'Ubuntu',
      repoIds: ['repo-1'],
      folderWorkspaceIds: []
    })
    await bringWslMovedProjectBack(project, async () => true)
    expect(call).toHaveBeenCalledWith({ kind: 'repo', id: 'repo-1' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('explains a refusal', async () => {
    stubApi({ released: false, reason: 'superseded' })
    await bringWslMovedProjectBack(project, async () => true)
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('A later move'))
  })

  it('asks to wait while a move of the distro still runs', async () => {
    stubApi({ released: false, reason: 'move-running' })
    await bringWslMovedProjectBack(project, async () => true)
    expect(toastError).toHaveBeenCalledWith(
      'A move to the Ubuntu host is still running. Try again once it ends.'
    )
  })
})
