import { useEffect } from 'react'
import { openOsRequestedFile } from '@/lib/open-os-requested-file'

// Why: run after session hydration — matching an existing workspace needs worktreesByRepo/folderWorkspaces populated.
export async function pullPendingOsRequestedFiles(isCancelled: () => boolean): Promise<void> {
  const pendingPaths = await window.api.osFileOpen.takePending()
  if (isCancelled()) {
    return
  }
  for (const pendingPath of pendingPaths) {
    await openOsRequestedFile(pendingPath)
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
