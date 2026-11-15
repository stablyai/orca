import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { Toaster } from '../../../ui/sonner'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import type { GitWorktreeInfo } from '../../../../../../shared/worktree/types'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'

const PARENT = '/home/neil/orca/workspaces/orca/react-use-effects'
const CHILD = `${PARENT}/.context/wt-safe-merge`
const WORKTREE_ID = `orca::${PARENT}`
const REMOTE_HOST: ExecutionHostId = toRuntimeExecutionHostId('omarchy')

const plan: GitWorktreeInfo[] = [
  {
    path: CHILD,
    head: 'b1',
    branch: 'refs/heads/safe-merge',
    isBare: false,
    isMainWorktree: false
  },
  {
    path: PARENT,
    head: 'a1',
    branch: 'refs/heads/react-use-effects',
    isBare: false,
    isMainWorktree: false
  }
]

function NestedRefusalToast({ hostId }: { hostId: ExecutionHostId | null }): React.JSX.Element {
  useEffect(() => {
    // The fixture bridge has no paired host; stand in for the host's nested-worktree preview.
    window.api = {
      ...window.api,
      worktrees: { ...window.api.worktrees, previewNestedRemoval: async () => plan }
    }
    showDeleteWorktreeFailureToast({
      error: `Refusing to delete worktree because it contains another registered worktree: ${CHILD}`,
      canForceDelete: false,
      forceDeleteReason: null,
      onViewChanges: () => {},
      onForceDelete: () => {},
      onDeleteAnyway: () => {},
      worktreeId: WORKTREE_ID,
      executionHostId: hostId,
      worktreeName: 'react-use-effects',
      nestedRemovalTarget: { id: WORKTREE_ID, executionHostId: hostId }
    })
    return () => {
      toast.dismiss()
    }
  }, [hostId])
  return (
    <>
      <div className="h-[900px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

async function waitFor<T>(find: () => T | null | undefined): Promise<T> {
  const deadline = performance.now() + 3000
  for (;;) {
    const found = find()
    if (found) {
      return found
    }
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for fixture element')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const findButton = (frame: HTMLElement, label: RegExp): HTMLButtonElement | undefined =>
  [...frame.ownerDocument.querySelectorAll('button')].find((button) =>
    label.test(button.textContent ?? '')
  )

export const remoteRefusal = defineFixture({
  width: 1280,
  render: () => <NestedRefusalToast hostId={REMOTE_HOST} />,
  interact: async () => {
    await waitFor(() => document.querySelector('[data-sonner-toast][data-mounted="true"]'))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})

// Previews through the mocked local bridge; a remote host answers the same plan over worktree.previewNestedRemoval.
export const review = defineFixture({
  width: 1280,
  render: () => <NestedRefusalToast hostId={null} />,
  interact: async (frame) => {
    ;(await waitFor(() => findButton(frame, /nested worktrees/))).click()
    await waitFor(() => document.querySelector('[role="dialog"]'))
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
})
