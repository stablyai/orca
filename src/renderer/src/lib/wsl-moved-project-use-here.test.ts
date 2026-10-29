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

/** Confirms, then returns the refusal notice: a dialog that only acknowledges. */
async function refusalShown(): Promise<string | undefined> {
  const confirm = vi.fn(async (_options: ConfirmationDialogOptions) => true)
  await bringWslMovedProjectBack(project, confirm)
  // A toast for this sat behind the update notice, so nothing seemed to happen.
  expect(confirm).toHaveBeenCalledTimes(2)
  expect(confirm.mock.calls[1]?.[0]).toMatchObject({ acknowledgeOnly: true })
  return confirm.mock.calls[1]?.[0]?.description
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

  it("brings the project back when the unsaved files are another project's", async () => {
    openFiles.push({ id: 'f2', relativePath: 'other.md', worktreeId: 'repo-2::/w', isDirty: true })
    const call = stubApi({
      released: true,
      distro: 'Ubuntu',
      repoIds: ['repo-1'],
      folderWorkspaceIds: []
    })
    const confirm = vi.fn(async (_options: ConfirmationDialogOptions) => true)
    await bringWslMovedProjectBack(project, confirm)
    expect(call).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(1)
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
    const confirm = vi.fn(async (_options: ConfirmationDialogOptions) => true)
    await bringWslMovedProjectBack(project, confirm)
    expect(call).toHaveBeenCalledWith({ kind: 'repo', id: 'repo-1', unsavedWorkspaceIds: [] })
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('explains a refusal', async () => {
    stubApi({ released: false, reason: 'superseded' })
    expect(await refusalShown()).toEqual(expect.stringContaining('A later move'))
  })

  it('names the newer move to bring back first', async () => {
    // Undoing an older move said nothing about which newer one blocked it.
    movedProjects.splice(0, movedProjects.length, {
      kind: 'repo',
      id: 'repo-9',
      displayName: 'Repo 9'
    })
    stubApi({
      released: false,
      reason: 'superseded',
      newerMove: { repoIds: ['repo-9'], folderWorkspaceIds: [] }
    })
    expect(await refusalShown()).toBe(
      'Repo 9 moved to the Ubuntu host after this project. Use those on this computer again first, then this project.'
    )
  })

  it('asks to wait while a move of the distro still runs', async () => {
    stubApi({ released: false, reason: 'move-running' })
    expect(await refusalShown()).toBe(
      'A move to the Ubuntu host is still running. Try again once it ends.'
    )
  })

  it("says to connect the host when its automations couldn't be turned off", async () => {
    for (const reason of ['host-unreachable', 'failed'] as const) {
      stubApi({ released: false, reason, detail: 'host-automations' })
      expect(await refusalShown()).toBe(
        "Orca couldn't turn off this project's automations on the Ubuntu host, so they could run twice. Connect the host in Settings, then try again."
      )
    }
  })

  it('says a host still being removed is left alone', async () => {
    stubApi({ released: false, reason: 'failed', detail: 'host-removal-pending' })
    expect(await refusalShown()).toBe(
      'The Ubuntu host is still being removed, so Orca leaves it alone. Finish removing it in Settings, then try again.'
    )
  })

  it('says a host removed here but kept for another Orca needs re-adding', async () => {
    stubApi({ released: false, reason: 'host-unreachable', detail: 'host-kept-for-peers' })
    expect(await refusalShown()).toBe(
      'Repo 1 moved to the Ubuntu host, which is still running for another Orca. Re-add the host to use it here again.'
    )
  })
})
