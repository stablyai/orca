import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  resolveAgentStagingWorktreePath,
  stageClientFilesForAgent
} from '@/runtime/files/imports/agent-file-staging'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { reportTerminalDropUploadSkipsAndFailures } from '@/components/terminal-pane/input/file-drop/terminal-drop-upload-report'
import { terminalFileDropErrorMessage } from '@/components/terminal-pane/input/file-drop/terminal-native-file-drop-error'
import { worktreeIdFromRuntimeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import type { RemoteBrowserDialogPage } from './remote-browser-javascript-dialog'

/** Copies this computer's files to the server running a streamed page, as a terminal drop does; returns the server's paths. */
export async function stageRemoteBrowserFilesOnHost(
  { target, worktree }: RemoteBrowserDialogPage,
  paths: string[]
): Promise<string[]> {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const worktreeId = worktreeIdFromRuntimeSelector(worktree)
  const worktreePath =
    environmentId && worktreeId
      ? resolveAgentStagingWorktreePath(
          worktreeId,
          undefined,
          toRuntimeExecutionHostId(environmentId),
          environmentId
        )
      : null
  if (!environmentId || !worktreeId || !worktreePath) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.ce8248b835',
        'Worktree path not available.'
      )
    )
    return []
  }
  const pending = toast.loading(
    translate(
      'auto.components.terminal.pane.terminal.drop.handler.uploadingFiles',
      'Uploading {{count}} files to runtime…',
      { count: paths.length, defaultValue_one: 'Uploading {{count}} file to runtime…' }
    )
  )
  try {
    const { staged, skipped, failed } = await stageClientFilesForAgent(
      { runtimeEnvironmentId: environmentId, worktreeId, worktreePath },
      paths,
      undefined,
      { keepNames: true }
    )
    reportTerminalDropUploadSkipsAndFailures(skipped, failed)
    return staged.map(({ hostPath }) => hostPath)
  } catch (error) {
    toast.error(terminalFileDropErrorMessage(error, 'upload'))
    return []
  } finally {
    toast.dismiss(pending)
  }
}
