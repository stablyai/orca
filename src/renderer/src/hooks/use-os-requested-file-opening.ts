import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openOsRequestedFile } from '@/lib/open-os-requested-file'

// Why: shared by both entry points so a failure can never surface as the startup effect's
// hydration-failure catch nor as an unhandled rejection from the push subscription.
async function openOsRequestedFileAndReportFailure(filePath: string): Promise<void> {
  try {
    await openOsRequestedFile(filePath)
  } catch (err) {
    console.warn('Failed to open OS-requested file:', filePath, err)
    toast.error(
      translate('auto.hooks.useOsRequestedFileOpening.b7f1c4a2d9', 'Could not open the file.')
    )
  }
}

// Why: run after session hydration — matching an existing workspace needs worktreesByRepo/folderWorkspaces populated.
export async function pullPendingOsRequestedFiles(isCancelled: () => boolean): Promise<void> {
  const pendingPaths = await window.api.osFileOpen.takePending()
  if (isCancelled()) {
    return
  }
  for (const pendingPath of pendingPaths) {
    await openOsRequestedFileAndReportFailure(pendingPath)
  }
}

// Why: own effect — files opened from the OS while Orca is already running have a lifecycle distinct from the startup hydration effect.
export function useOsRequestedFileOpening(): void {
  useEffect(() => {
    return window.api.osFileOpen.onOpened((filePath) => {
      void openOsRequestedFileAndReportFailure(filePath)
    })
  }, [])
}
