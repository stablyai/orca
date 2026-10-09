import { toast } from 'sonner'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { getLocalFileManager } from './local-file-manager-label'
import { settingsForRuntimeOwner } from '@/runtime/runtime-client-target'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from './local-path-open-guard'

/** Menu label for showing a path in the OS file manager, as each platform names it. */
export function getRevealInFileManagerLabel(): string {
  switch (getLocalFileManager()) {
    case 'finder':
      return translate(
        'auto.components.right.sidebar.FileExplorerRow.revealInFinder',
        'Reveal in Finder'
      )
    case 'file-explorer':
      return translate(
        'auto.components.right.sidebar.FileExplorerRow.revealInFileExplorer',
        'Reveal in File Explorer'
      )
    case 'file-manager':
      return translate(
        'auto.components.right.sidebar.FileExplorerRow.openContainingFolder',
        'Open Containing Folder'
      )
  }
}

/**
 * Whether the OS file manager cannot show a file because another host owns it. The runtime owner
 * is null for this client; omitting it falls back to the focused runtime, as the main process does.
 */
export function isRevealInFileManagerBlocked(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  owner: { connectionId?: string | null; runtimeEnvironmentId?: string | null }
): boolean {
  // Why: global runtime focus is not ownership; a local workspace's files stay revealable.
  return isLocalPathOpenBlocked(settingsForRuntimeOwner(settings, owner.runtimeEnvironmentId), {
    connectionId: owner.connectionId
  })
}

/** Shows a client-local path selected in the OS file manager, and says why when it cannot. */
export async function revealInFileManager(
  path: string,
  runtimeEnvironmentId?: string | null
): Promise<void> {
  const result = await window.api.shell.openInFileManager(path, runtimeEnvironmentId)
  if (result.ok) {
    return
  }
  if (result.reason === 'remote-runtime-unsupported') {
    showLocalPathOpenBlockedToast()
    return
  }
  toast.error(
    result.reason === 'launch-failed'
      ? translate('auto.lib.reveal.in.file.manager.launchFailed', 'Could not reveal the file.')
      : translate(
          'auto.lib.reveal.in.file.manager.notFound',
          'File not found. It may have been moved or deleted.'
        )
  )
}
