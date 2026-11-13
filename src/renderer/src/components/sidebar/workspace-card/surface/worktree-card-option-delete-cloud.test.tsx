// @vitest-environment happy-dom
// OPTION-TRASH-CLOUD: holding Option shows the trash on a cloud workspace's own row (owned or
// paired), the live card's DeleteQuickAction, and it opens the cloud delete (sandbox), never the
// local "Remove Project". A local repo's primary checkout still gets no trash.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { canShowWorkspaceDeleteQuickAction } from '../../workspace-actions/deletion/workspace-delete-quick-action'
import WorktreeCard from './WorktreeCard'

const mocks = vi.hoisted(() => ({ cloudDelete: vi.fn() }))
vi.mock('@/lib/orca-cloud/cloud-primary-delete-request', () => ({
  requestCloudPrimaryDelete: mocks.cloudDelete
}))
vi.mock('@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false,
  selectIsSleepingWorktree: () => false
}))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'inactive'
}))

const repo = makeRepo()
const ownedCloud = makeWorktree('cloud-owned', 'Owned cloud', { isMainWorktree: true })
const pairedCloud = makeWorktree('cloud-paired', 'Paired cloud', {
  isMainWorktree: true,
  hostId: 'runtime:env-paired'
})
const localPrimary = makeWorktree('local-main', 'Local primary', { isMainWorktree: true })
const localWorktree = makeWorktree('local-wt', 'Local worktree')

function seed(): void {
  act(() => {
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [ownedCloud, pairedCloud, localPrimary, localWorktree] },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cloud row check reads only id and orcaCloudPaired.
      runtimeEnvironments: [
        { id: 'env-paired', name: 'web (cloud)', orcaCloudPaired: true }
      ] as never
    })
    seedCloudWorkspaceSnapshot({ ids: new Set(['cloud-owned']), idsLoaded: true })
  })
}

function card(worktree: ReturnType<typeof makeWorktree>) {
  return render(
    <TooltipProvider>
      <WorktreeCard worktree={worktree} repo={repo} isActive={false} nativeDragEnabled={false} />
    </TooltipProvider>
  )
}

const trash = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Delete workspace"]')

afterEach(() => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }))
  })
  cleanup()
  seedCloudWorkspaceSnapshot({})
  mocks.cloudDelete.mockReset()
})

describe('Option shows the trash on cloud rows (OPTION-TRASH-CLOUD)', () => {
  it('the gate: a cloud primary is deletable, a local primary is not', () => {
    const held = { deleteModifierPressed: true, isDeleting: false }
    expect(canShowWorkspaceDeleteQuickAction({ ...held, isMainWorktree: true })).toBe(false)
    expect(
      canShowWorkspaceDeleteQuickAction({ ...held, isMainWorktree: true, cloudPrimary: true })
    ).toBe(true)
    expect(canShowWorkspaceDeleteQuickAction({ ...held, isMainWorktree: false })).toBe(true)
    // Never without Option, never while deleting.
    expect(
      canShowWorkspaceDeleteQuickAction({
        deleteModifierPressed: false,
        isDeleting: false,
        isMainWorktree: true,
        cloudPrimary: true
      })
    ).toBe(false)
    expect(
      canShowWorkspaceDeleteQuickAction({
        deleteModifierPressed: true,
        isDeleting: true,
        isMainWorktree: true,
        cloudPrimary: true
      })
    ).toBe(false)
  })

  it.each([
    ['owned', ownedCloud],
    ['paired', pairedCloud]
  ])('%s cloud row: Option shows the trash and it opens the cloud delete', (_kind, worktree) => {
    seed()
    const view = card(worktree)
    expect(trash(view.container)).toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }))
    })
    const button = trash(view.container)
    expect(button).not.toBeNull()
    fireEvent.click(button!)
    expect(mocks.cloudDelete).toHaveBeenCalledWith(expect.objectContaining({ id: worktree.id }))
    expect(useAppStore.getState().activeModal).not.toBe('confirm-remove-folder')
  })

  it('a local primary still gets no trash; a local worktree does', () => {
    seed()
    const primary = card(localPrimary)
    const worktree = card(localWorktree)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }))
    })
    expect(trash(primary.container)).toBeNull()
    expect(trash(worktree.container)).not.toBeNull()
  })
})
