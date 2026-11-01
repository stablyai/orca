import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

/** Pending or failed while main creates the workspace's managed profile; its pages must not mount until then. */
export function useManagedBrowserProfileStatus(
  sessionProfileId: string | null | undefined
): 'pending' | 'failed' | undefined {
  return useAppStore((s) =>
    sessionProfileId ? s.managedBrowserProfileStatusById[sessionProfileId] : undefined
  )
}

export function ManagedBrowserProfileHold({
  status
}: {
  status: 'pending' | 'failed'
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
      {status === 'failed'
        ? translate(
            'browser.managedProfile.createFailed',
            "Couldn't create this workspace's browser profile. Close this tab and open a new one to try again."
          )
        : null}
    </div>
  )
}
