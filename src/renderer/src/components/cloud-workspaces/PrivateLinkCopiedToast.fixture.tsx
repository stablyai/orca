// Copy link on a private cloud workspace, for its owner (Share with team) and
// for someone who can't share it.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '@/components/ui/sonner'
import { privateLinkToastId, toastPrivateLinkCopied } from './private-link-copied-toast'

function PrivateToast({ canShare }: { canShare: boolean }): React.JSX.Element {
  useEffect(() => {
    // After the Toaster has mounted: a toast raised before it subscribes is not shown.
    const timer = window.setTimeout(
      () => toastPrivateLinkCopied('sbx_fixture', false, canShare),
      100
    )
    return () => {
      window.clearTimeout(timer)
      toast.dismiss(privateLinkToastId('sbx_fixture'))
    }
  }, [canShare])
  return (
    <>
      <div className="h-[900px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

const waitForToast = async (): Promise<void> => {
  const deadline = performance.now() + 3000
  while (document.querySelector('[data-sonner-toast][data-mounted="true"]') === null) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the toast')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}

export const owner = defineFixture({
  width: 1280,
  render: () => <PrivateToast canShare />,
  interact: waitForToast
})

export const notOwner = defineFixture({
  width: 1280,
  render: () => <PrivateToast canShare={false} />,
  interact: waitForToast
})
