import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openOsRequestedFile } from '@/lib/open-os-requested-file'

// Why: run after session hydration — matching an existing workspace needs worktreesByRepo/folderWorkspaces populated.
export async function pullPendingOsRequestedFiles(isCancelled: () => boolean): Promise<void> {
  const pendingPaths = await window.api.osFileOpen.takePending()
  if (isCancelled()) {
    return
  }
  for (const pendingPath of pendingPaths) {
    // Why: a bad path must not abort the rest, and must never surface as the startup effect's generic hydration-failure catch.
    try {
      await openOsRequestedFile(pendingPath)
    } catch (err) {
      console.warn('Failed to open OS-requested file:', pendingPath, err)
      toast.error(
        translate('auto.hooks.useOsRequestedFileOpening.b7f1c4a2d9', 'Could not open the file.')
      )
    }
  }
}

// Why: own effect — files opened from the OS while Orca is already running have a lifecycle distinct from the startup hydration effect.
export function useOsRequestedFileOpening(): void {
  useEffect(() => {
    return window.api.osFileOpen.onOpened((filePath) => {
      void openOsRequestedFile(filePath)
    })
  }, [])
}
