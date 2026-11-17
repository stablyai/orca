// The move's done toast next to the one it reuses: a workspace created in the background.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '../ui/sonner'
import { showWorktreeCreationReadyToast } from '@/lib/workspace/creation/worktree-creation-ready-toast'
import { showCloudMoveDoneToast } from '@/lib/orca-cloud/orca-cloud-move-run-parts'

const worktree = {
  id: 'repo-1::/Users/me/orca/workspaces/sando123',
  repoId: 'repo-1',
  displayName: 'sando123',
  branch: 'refs/heads/orca-cloud-dev/sando123',
  path: '/Users/me/orca/workspaces/sando123',
  hostId: undefined
}

function ToastHost({ show }: { show: () => void }): React.JSX.Element {
  useEffect(() => {
    show()
    return () => {
      toast.dismiss()
    }
  }, [show])
  return (
    <>
      <div className="h-[900px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

const settle = async (): Promise<void> => {
  const deadline = performance.now() + 3000
  while (!document.querySelector('[data-sonner-toast][data-mounted="true"]')) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the toast')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}

const showReady = (): void => showWorktreeCreationReadyToast(worktree)
const showMoved = (): void => showCloudMoveDoneToast(worktree, 'sando123', true, 30)
const showMovedKept = (): void => showCloudMoveDoneToast(worktree, 'sando123', false, 30)

/** Upstream: a worktree created in the background. */
export const worktreeReady = defineFixture({
  width: 1280,
  render: () => <ToastHost show={showReady} />,
  interact: settle
})

/** The move landed in full, cloud copy archived. */
export const movedHere = defineFixture({
  width: 1280,
  render: () => <ToastHost show={showMoved} />,
  interact: settle
})

/** The move landed in full, archive unticked: no footer. */
export const movedHereKept = defineFixture({
  width: 1280,
  render: () => <ToastHost show={showMovedKept} />,
  interact: settle
})
