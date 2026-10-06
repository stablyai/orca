import { toast } from 'sonner'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { getLocalFileManager } from './local-file-manager-label'
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
 * Whether the OS file manager cannot show a file: another host owns it, or a remote runtime is
 * focused, which makes the main process refuse every reveal.
 */
export function isRevealInFileManagerBlocked(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  owner: { connectionId?: string | null; runtimeEnvironmentId?: string | null }
): boolean {
  return (
    isLocalPathOpenBlocked(settings, { connectionId: owner.connectionId }) ||
    Boolean(owner.runtimeEnvironmentId?.trim())
  )
}

/** Shows a client-local path selected in the OS file manager, and says why when it cannot. */
export async function revealInFileManager(path: string): Promise<void> {
  const result = await window.api.shell.openInFileManager(path)
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
