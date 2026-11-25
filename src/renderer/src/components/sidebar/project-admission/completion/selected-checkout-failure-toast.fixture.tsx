import { useEffect } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { projectAddToastId } from '@/store/repos/repo-state'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  showSelectedCheckoutFailure,
  type SelectedCheckoutFailure
} from './selected-checkout-failure-toast'

const REPO_ID = 'fixture-repo'
const LIVE_TOAST = '[data-sonner-toast]:not([data-removed="true"])'

function ToastStage(): React.JSX.Element {
  useEffect(
    () => () => {
      toast.dismiss()
    },
    []
  )
  // A transform makes this frame the toaster's fixed-position containing block, like a 600px window.
  return (
    <div className="relative h-[240px] w-[600px] [transform:translateZ(0)]">
      <Toaster
        closeButton
        toastOptions={{ className: 'font-sans text-sm', duration: Number.POSITIVE_INFINITY }}
      />
    </div>
  )
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Raises the add's own toast first, as the add flow does, then the handoff failure. */
function failureAfterAdd(failure: SelectedCheckoutFailure) {
  return defineFixture({
    width: 600,
    render: () => <ToastStage />,
    interact: async () => {
      toast.info('Project already added', {
        id: projectAddToastId(REPO_ID),
        description: 'primary'
      })
      await waitFor(() => document.querySelector(LIVE_TOAST) !== null, 'the add toast')
      showSelectedCheckoutFailure(REPO_ID, failure)
      await waitFor(
        () => document.querySelector(LIVE_TOAST)?.getAttribute('data-type') === 'error',
        'the failure toast'
      )
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (document.querySelectorAll(LIVE_TOAST).length !== 1) {
        throw new Error('The failure must replace the add toast, not stack under it')
      }
    }
  })
}

const retry = () => undefined

export const refreshFailed = failureAfterAdd({
  kind: 'refresh_failed',
  hostLabel: 'build-server',
  retry
})
export const checkoutMissing = failureAfterAdd({ kind: 'missing', retry })
export const ownerUnavailable = failureAfterAdd({ kind: 'owner_unavailable' })
