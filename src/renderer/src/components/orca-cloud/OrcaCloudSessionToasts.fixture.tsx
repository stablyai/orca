import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '../ui/sonner'
import {
  showOrcaCloudCleanupDoneToast,
  showOrcaCloudCleanupFailedToast,
  showOrcaCloudCleanupStartedToast,
  showOrcaCloudRestartWarningToast,
  showOrcaCloudRestartingToast
} from '@/lib/orca-cloud-session-toasts'
import type { HostedSessionWarningEvent } from '../../../../shared/hosted-sandbox/hosted-session-events'

const workspace = { workspaceId: 'wt-cloud', workspaceName: 'fix-login-flake' }
const noop = (): void => {}
const restartActions = {
  restartNow: async () => ({ status: 'restarted' as const }),
  open: noop
}

function ToastStage({ show }: { show: () => void }): React.JSX.Element {
  useEffect(() => {
    show()
    return () => {
      toast.dismiss()
    }
  }, [show])
  return (
    // The transform makes this box the toaster's fixed-position frame, so the shot holds the toast.
    <div className="relative h-[220px] [transform:translateZ(0)]">
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

async function waitForMountedToast(
  selector = '[data-sonner-toast][data-mounted="true"]'
): Promise<void> {
  const deadline = performance.now() + 3000
  while (!document.querySelector(selector)) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the toast')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // Let the enter transition finish before the shot.
  await new Promise((resolve) => setTimeout(resolve, 500))
}

function toastFixture(show: () => void) {
  return defineFixture({
    width: 480,
    render: () => <ToastStage show={show} />,
    interact: () => waitForMountedToast()
  })
}

function warning(minutesLeft: HostedSessionWarningEvent['minutesLeft']): () => void {
  return () => showOrcaCloudRestartWarningToast({ ...workspace, minutesLeft }, restartActions)
}

/** 60 and 15 min left: dismisses itself after 20s. */
export const restartWarning = toastFixture(warning(60))
/** 5 min left: stays until the user acts or the restart happens. */
export const restartWarningPersistent = toastFixture(warning(5))
export const restarting = toastFixture(() =>
  showOrcaCloudRestartingToast(workspace.workspaceId, workspace.workspaceName)
)
/** "Restart now" clicked: the warning becomes the restart's result. */
export const restartedAfterRestartNow = defineFixture({
  width: 480,
  render: () => <ToastStage show={warning(15)} />,
  interact: async () => {
    await waitForMountedToast()
    const restart = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-sonner-toast] button')
    ].find((button) => button.textContent === 'Restart now')
    restart?.click()
    await waitForMountedToast('[data-sonner-toast][data-type="success"]')
  }
})
export const cleanupInProgress = toastFixture(() => showOrcaCloudCleanupStartedToast('c-1'))
export const cleanupDone = toastFixture(() => showOrcaCloudCleanupDoneToast('c-1'))
export const cleanupFailed = toastFixture(() => showOrcaCloudCleanupFailedToast('c-1', noop))
