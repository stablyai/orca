// EP-6-FLAKE: the three states of a cloud workspace open that does not finish quickly: still opening
// (loading), taking longer than usual (warning, Try again), and gone (error, Show cloud workspaces).
import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '@/components/ui/sonner'
import {
  beginCloudWorkspaceOpenFeedback,
  endCloudWorkspaceOpenFeedback,
  resetCloudWorkspaceOpenFeedbackForTests,
  type OpenFeedbackFailure
} from './cloud-workspace-open-feedback'

const noActions = { retry: () => undefined, showWorkspaces: () => undefined }

function OpenToast({ failure }: { failure: OpenFeedbackFailure | null }): React.JSX.Element {
  useEffect(() => {
    // After the Toaster has mounted: a toast raised before it subscribes is not shown.
    const timer = window.setTimeout(() => {
      beginCloudWorkspaceOpenFeedback('fixture', 'web')
      if (failure) {
        endCloudWorkspaceOpenFeedback('fixture', { ok: false, failure }, noActions)
      }
    }, 100)
    return () => {
      window.clearTimeout(timer)
      resetCloudWorkspaceOpenFeedbackForTests()
      toast.dismiss()
    }
  }, [failure])
  return (
    <>
      <div className="h-[900px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

async function toastShown(): Promise<void> {
  const deadline = performance.now() + 6000
  while (document.querySelector('[data-sonner-toast][data-mounted="true"]') === null) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the open toast')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // Let the toast finish its entrance before the shot.
  await new Promise((resolve) => setTimeout(resolve, 500))
}

/** Still opening after the delay (loading). */
export const opening = defineFixture({
  width: 1280,
  render: () => <OpenToast failure={null} />,
  interact: toastShown
})

/** The open timed out while the workspace is still starting (warning, Try again). */
export const takingLonger = defineFixture({
  width: 1280,
  render: () => <OpenToast failure="timeout" />,
  interact: toastShown
})

/** The workspace is gone (error, Show cloud workspaces). */
export const gone = defineFixture({
  width: 1280,
  render: () => <OpenToast failure="gone" />,
  interact: toastShown
})
