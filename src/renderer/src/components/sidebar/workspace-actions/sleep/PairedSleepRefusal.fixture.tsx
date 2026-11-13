// SHARED-MEMBER-SLEEP-HANG: a member on a teammate's shared cloud workspace sees Sleep disabled with
// who can do it; a refusal that still happens (role changed mid-session) is a warning toast.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Toaster } from '@/components/ui/sonner'
import {
  pairedSleepOwnerOnlyHint,
  showPairedSleepRefusedToast
} from '@/lib/orca-cloud/paired-sleep-refused-toast'
import { WorkspaceSleepMenuItems } from './WorkspaceSleepMenuItems'

/** The row menu's Sleep, disabled for a member, with the reason on its second line. */
export const memberSleepDisabled = defineFixture({
  width: 360,
  render: () => (
    <div className="h-[200px]">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className="text-sm">
            endpass-shared
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <WorkspaceSleepMenuItems
            isMultiContext={false}
            sleepLabel="Sleep"
            sleepDisabled={false}
            descendantCount={0}
            subtreeSleepDisabled
            onSleep={() => undefined}
            onSleepSubtree={() => undefined}
            sleepRefusedHint={pairedSleepOwnerOnlyHint()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

function RefusedToast(): React.JSX.Element {
  useEffect(() => {
    // After the Toaster has mounted: a toast raised before it subscribes is not shown.
    const timer = window.setTimeout(
      () => showPairedSleepRefusedToast('endpass-shared', 'fixture'),
      100
    )
    return () => {
      window.clearTimeout(timer)
      toast.dismiss('paired-sleep-refused:fixture')
    }
  }, [])
  return (
    <>
      <div className="h-[900px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

/** The refusal (warning tone): who can put it to sleep, no action. */
export const memberSleepRefusedToast = defineFixture({
  width: 1280,
  render: () => <RefusedToast />,
  interact: async () => {
    const deadline = performance.now() + 3000
    while (document.querySelector('[data-sonner-toast][data-mounted="true"]') === null) {
      if (performance.now() > deadline) {
        throw new Error('Timed out waiting for the refusal toast')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Let the toast finish its entrance before the shot.
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})
