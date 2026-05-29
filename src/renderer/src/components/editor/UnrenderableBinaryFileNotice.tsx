import { ExternalLink, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getConnectionId } from '@/lib/connection-context'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { revealInFileManagerLabel } from '@/lib/reveal-in-file-manager-label'

/**
 * Fallback shown when a binary file can't be rendered in Orca (Office docs,
 * archives, …). Offers local-OS recovery actions so the user isn't dead-ended,
 * e.g. after ⌘-clicking a .docx terminal link.
 */
export default function UnrenderableBinaryFileNotice({
  filePath,
  worktreeId,
  runtimeEnvironmentId
}: {
  filePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  // Why: reveal/open hand a path to the local OS, which only makes sense for
  // local files — remote runtime/SSH paths belong to another machine.
  const localOpenBlocked = isLocalPathOpenBlocked(
    settingsForRuntimeOwner(settings, runtimeEnvironmentId),
    { connectionId: getConnectionId(worktreeId) }
  )

  const openExternally = (): void => {
    if (localOpenBlocked) {
      showLocalPathOpenBlockedToast()
      return
    }
    void window.api.shell.openFilePath(filePath)
  }

  const reveal = (): void => {
    if (localOpenBlocked) {
      showLocalPathOpenBlockedToast()
      return
    }
    void window.api.shell.openInFileManager(filePath)
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-sm text-muted-foreground">Orca can&rsquo;t preview this file type.</div>
      {!localOpenBlocked ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="default" size="sm" onClick={openExternally}>
            <ExternalLink />
            Open with Default App
          </Button>
          <Button variant="outline" size="sm" onClick={reveal}>
            <FolderOpen />
            {revealInFileManagerLabel}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
