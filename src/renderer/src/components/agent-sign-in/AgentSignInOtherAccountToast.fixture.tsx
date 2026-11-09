import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '@/components/ui/sonner'
import { warnHostAgentOtherAccount } from '@/lib/agent-sign-in/host-agent-sign-out'

function OtherAccountToast(): React.JSX.Element {
  useEffect(() => {
    // After the Toaster mounts, which listens only from then on.
    const timer = window.setTimeout(() => {
      warnHostAgentOtherAccount(
        { key: 'fixture', environmentId: 'env-m4air', hostLabel: 'm4air', agent: 'claude' },
        'nw@personal.dev',
        'nw@stably.ai'
      )
    }, 50)
    return () => {
      window.clearTimeout(timer)
      toast.dismiss('agent-sign-in-other-account:fixture')
    }
  }, [])
  return (
    <>
      <div className="h-[900px] bg-background" />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

export const otherAccountToast = defineFixture({
  width: 1280,
  render: () => <OtherAccountToast />,
  interact: async () => {
    const deadline = performance.now() + 3000
    while (
      document.querySelector('[data-sonner-toast]')?.getAttribute('data-mounted') !== 'true' &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})
