import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useMemo: <T>(factory: () => T) => factory()
  }
})

const mocks = vi.hoisted(() => ({
  state: {
    closeModal: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  },
  markOnboardingProjectAdded: vi.fn(() => Promise.resolve())
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('@/lib/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: mocks.markOnboardingProjectAdded
}))

import { useAddRepoHostedController } from './use-add-repo-hosted-controller'

describe('useAddRepoHostedController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to the store closeModal without a hosted controller', () => {
    const { closeModal, closeForFolderHandoff, finishProjectAdd } =
      useAddRepoHostedController(undefined)
    closeModal()
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
    closeForFolderHandoff()
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(2)
    expect(finishProjectAdd).toBeUndefined()
  })

  it('closes only the hosted dialog, never the store modal slot', () => {
    const onOpenChange = vi.fn()
    const { closeModal } = useAddRepoHostedController({
      open: true,
      onOpenChange,
      onProjectAdded: vi.fn()
    })
    closeModal()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.state.closeModal).not.toHaveBeenCalled()
  })

  it('folder handoffs close both the hosted dialog and the composer modal', () => {
    const onOpenChange = vi.fn()
    const { closeForFolderHandoff } = useAddRepoHostedController({
      open: true,
      onOpenChange,
      onProjectAdded: vi.fn()
    })
    // Why: folder/non-git outcomes navigate (folder-workspace activation or
    // the confirm-non-git-folder store modal); leaving the composer open
    // would hide that navigation behind a stale project selection.
    closeForFolderHandoff()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })

  it('finishProjectAdd closes the hosted dialog and hands the repo to the host', async () => {
    const order: string[] = []
    const onOpenChange = vi.fn(() => order.push('close'))
    const onProjectAdded = vi.fn(() => {
      order.push('added')
    })
    const { finishProjectAdd } = useAddRepoHostedController({
      open: true,
      onOpenChange,
      onProjectAdded
    })
    await finishProjectAdd?.('repo-1', 'local_folder_picker')
    expect(mocks.markOnboardingProjectAdded).toHaveBeenCalledWith('addedRepo')
    expect(onProjectAdded).toHaveBeenCalledWith('repo-1')
    // Why: closing before selection keeps the composer visible under the
    // dialog's close animation while the new project lands in the picker.
    expect(order).toEqual(['close', 'added'])
  })

  it('hands an imported group to the host instead of one member project', async () => {
    const onProjectAdded = vi.fn()
    const onProjectGroupImported = vi.fn(() => true)
    const { finishProjectAdd } = useAddRepoHostedController({
      open: true,
      onOpenChange: vi.fn(),
      onProjectAdded,
      onProjectGroupImported
    })
    await finishProjectAdd?.('repo-1', 'local_folder_picker', {
      importedProjectGroupId: 'group-1'
    })
    expect(onProjectGroupImported).toHaveBeenCalledWith('group-1')
    // Why: the user asked to import as a group, so a member project is not
    // the target they chose.
    expect(onProjectAdded).not.toHaveBeenCalled()
  })

  it('falls back to the project when the imported group is not selectable', async () => {
    const onProjectAdded = vi.fn()
    const { finishProjectAdd } = useAddRepoHostedController({
      open: true,
      onOpenChange: vi.fn(),
      onProjectAdded,
      onProjectGroupImported: vi.fn(() => false)
    })
    await finishProjectAdd?.('repo-1', 'local_folder_picker', {
      importedProjectGroupId: 'group-1'
    })
    expect(onProjectAdded).toHaveBeenCalledWith('repo-1')
  })

  it('falls back to the project when the host cannot select groups', async () => {
    const onProjectAdded = vi.fn()
    const { finishProjectAdd } = useAddRepoHostedController({
      open: true,
      onOpenChange: vi.fn(),
      onProjectAdded
    })
    await finishProjectAdd?.('repo-1', 'local_folder_picker', {
      importedProjectGroupId: 'group-1'
    })
    expect(onProjectAdded).toHaveBeenCalledWith('repo-1')
  })

  it('SSH settings navigation closes both hosted dialog and composer modal', () => {
    const onOpenChange = vi.fn()
    const { handleOpenSshSettings } = useAddRepoHostedController({
      open: true,
      onOpenChange,
      onProjectAdded: vi.fn()
    })
    handleOpenSshSettings()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.state.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'ssh',
      repoId: null,
      sectionId: 'ssh'
    })
    expect(mocks.state.openSettingsPage).toHaveBeenCalledTimes(1)
  })
})
