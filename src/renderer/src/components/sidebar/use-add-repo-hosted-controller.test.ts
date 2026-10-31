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
    closeModal: vi.fn()
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
    // Folder handoffs navigate away, so the composer must not remain above the new surface.
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
    // Close the nested dialog before selecting the project so its animation reveals the composer.
    expect(order).toEqual(['close', 'added'])
  })
  it.each([true, false])(
    'prefers the imported group when host accepts it (%s)',
    async (accepted) => {
      const onProjectAdded = vi.fn()
      const onProjectGroupImported = vi.fn(() => accepted)
      const { finishProjectAdd } = useAddRepoHostedController({
        open: true,
        onOpenChange: vi.fn(),
        onProjectAdded,
        onProjectGroupImported
      })
      await finishProjectAdd?.('repo-1', 'ssh_remote_path', 'ssh:box', {
        importedProjectGroupId: 'group'
      })
      expect(onProjectGroupImported).toHaveBeenCalledWith('group')
      expect(onProjectAdded).toHaveBeenCalledTimes(accepted ? 0 : 1)
    }
  )
})
