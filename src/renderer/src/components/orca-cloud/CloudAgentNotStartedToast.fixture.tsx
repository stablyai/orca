import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Toaster } from '@/components/ui/sonner'
import { agentNotStartedNotice } from '@/lib/orca-cloud/github-cloud-first-agent'

// #568: a GitHub-only Orca Cloud create whose workspace wasn't ready within the wait: the agent
// didn't start, and the toast says so (it goes away if the workspace becomes ready after all).
function NotStartedToast(): React.JSX.Element {
  useEffect(() => {
    // After the Toaster mounts, which listens only from then on.
    const timer = window.setTimeout(() => {
      agentNotStartedNotice('claude', 'acme/web', undefined)
    }, 50)
    return () => {
      window.clearTimeout(timer)
      toast.dismiss('cloud-agent-not-started:acme/web')
    }
  }, [])
  return (
    <>
      <div className="h-[900px] bg-background" />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

export const agentNotStartedToast = defineFixture({
  width: 1280,
  render: () => <NotStartedToast />,
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
