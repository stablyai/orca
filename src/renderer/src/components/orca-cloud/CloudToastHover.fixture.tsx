// Hovering a persistent cloud toast must not move it (the GitHub App push notice sank on
// hover and popped back on leave). settings: one card alone, and one under a newer plain toast.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '../ui/sonner'
import { hideCloudToast, resetCloudToasts, showCloudToast } from './cloud-toast-stack'

const noop = (): void => {}

function showPushNotice(text = PUSH_TEXT): void {
  showCloudToast('push:fixture', {
    priority: 'action',
    lines: [
      {
        key: 'push',
        text,
        action: { label: 'Install on octocat', onClick: noop, primary: true }
      }
    ]
  })
}

const PUSH_TEXT =
  'Orca Cloud can read octocat/hello-world but can’t push yet. Install the Orca GitHub App on octocat to push.'

function Stage({
  withPlainToast = false,
  grows = false
}: {
  withPlainToast?: boolean
  grows?: boolean
}): React.JSX.Element {
  useEffect(() => {
    // The notice's copy is settled after it shows (the repo resolves): the card grows in place.
    showPushNotice(grows ? 'Orca Cloud can’t push yet.' : PUSH_TEXT)
    const grow = grows ? window.setTimeout(() => showPushNotice(), 300) : undefined
    if (withPlainToast) {
      toast.success('Your app on port 3000 is available at localhost:3000', {
        duration: Number.POSITIVE_INFINITY,
        description: 'node · fix-login-flake'
      })
    }
    return () => {
      window.clearTimeout(grow)
      hideCloudToast('push:fixture')
      resetCloudToasts()
      toast.dismiss()
    }
  }, [withPlainToast, grows])
  return (
    <div className="h-[420px]">
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

export const alone = defineFixture({ width: 1280, render: () => <Stage /> })
/** Regression: a card whose copy grew after it showed stays put under the pointer when the stack
 *  expands on hover (it used to shrink to its first height and sink). */
export const grownAfterShowing = defineFixture({
  width: 1280,
  render: () => <Stage grows />,
  interact: async () => {
    const card = (): HTMLElement | null => document.querySelector('[data-cloud-toast]')
    const deadline = performance.now() + 3000
    while (!card()?.textContent?.includes('GitHub App')) {
      if (performance.now() > deadline) {
        throw new Error('Timed out waiting for the grown card')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    const before = card()!.getBoundingClientRect()
    // Sonner expands the stack on mouseenter/mousemove over its list (React derives enter from mouseover).
    for (const type of ['mouseover', 'mousemove']) {
      card()!.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }))
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (card()!.closest('[data-sonner-toast]')?.getAttribute('data-expanded') !== 'true') {
      throw new Error('The stack should expand on hover')
    }
    const after = card()!.getBoundingClientRect()
    if (Math.abs(after.top - before.top) > 1 || Math.abs(after.bottom - before.bottom) > 1) {
      throw new Error(
        `The hovered card moved: ${before.top}→${after.top}, ${before.bottom}→${after.bottom}`
      )
    }
    if (after.right > window.innerWidth || after.bottom > window.innerHeight) {
      throw new Error('The card must sit fully inside the window')
    }
  }
})
export const underPlainToast = defineFixture({
  width: 1280,
  render: () => <Stage withPlainToast />
})
