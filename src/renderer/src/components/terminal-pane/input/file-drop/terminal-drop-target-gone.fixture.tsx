import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { Toaster } from '../../../ui/sonner'
import { showTerminalDropTargetGone } from './terminal-drop-target-gone'

const DROP_PATH = '/srv/orca/workspaces/api-server/.orca/drops/model-eval-results.bin'

function TargetGoneToast(): React.JSX.Element {
  useEffect(() => {
    // Mirrors the end of a long runtime upload whose pane was parked or closed.
    showTerminalDropTargetGone([DROP_PATH])
    return () => {
      toast.dismiss()
    }
  }, [])
  return (
    <>
      <div className="h-[900px]" />
      <Toaster
        closeButton
        duration={Number.POSITIVE_INFINITY}
        toastOptions={{ className: 'font-sans text-sm' }}
      />
    </>
  )
}

async function waitForMountedToast(): Promise<void> {
  const deadline = performance.now() + 3000
  for (;;) {
    if (document.querySelector('[data-sonner-toast][data-mounted="true"]')) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return
    }
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the file-drop toast')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The upload already finished when its terminal was parked or closed; the toast
 *  says where the files landed instead of dismissing the progress toast silently. */
export const uploadedPathsAfterTerminalGone = defineFixture({
  // Matches the headless viewport so the viewport-anchored toast lands inside the capture clip.
  width: 1280,
  render: () => <TargetGoneToast />,
  interact: async () => {
    await waitForMountedToast()
  }
})
