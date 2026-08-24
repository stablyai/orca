import { toast } from 'sonner'
import type { ShellOpenExternalEditorResult } from '../../../../shared/shell-open-types'
import { translate } from '@/i18n/i18n'

export function showWorktreeOpenFailureToast(
  result: Exclude<ShellOpenExternalEditorResult, { ok: true }>,
  remote: boolean
): void {
  if (result.reason === 'remote-runtime-unsupported') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.remoteRuntimeUnsupported',
        'Opening this path in a local app is not available.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.remoteRuntimeUnsupportedDetail',
          'Switch to a local or SSH workspace, then try again.'
        )
      }
    )
    return
  }
  if (result.reason === 'runtime-ssh-target-required') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.runtimeSshTargetRequired',
        'A matching SSH host is required.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.runtimeSshTargetRequiredDetail',
          'Add exactly one SSH host matching this Orca server, then try again.'
        )
      }
    )
    return
  }
  if (result.reason === 'ssh-target-not-found') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.sshTargetNotFound',
        'SSH host is no longer available.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.sshTargetNotFoundDetail',
          'Refresh workspaces or reconnect the host, then try again.'
        )
      }
    )
    return
  }
  if (result.reason === 'ssh-target-invalid') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.sshTargetInvalid',
        'SSH host configuration is incomplete.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.sshTargetInvalidDetail',
          'Edit or reconnect the SSH host, then try again.'
        )
      }
    )
    return
  }
  if (result.reason === 'ssh-alias-required') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.sshAliasRequired',
        'VS Code needs an SSH config alias for this host.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.sshAliasRequiredDetail',
          'Add a Host alias for {{host}}:{{port}} to your local SSH config, reconnect the workspace, then try again.',
          { host: result.host, port: result.port }
        )
      }
    )
    return
  }
  if (result.reason === 'remote-editor-unsupported') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.remoteEditorUnsupported',
        'This app cannot open remote workspaces.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.remoteEditorUnsupportedDetail',
          'Choose an editor with remote workspace support or use the app locally.'
        )
      }
    )
    return
  }
  if (result.reason === 'not-absolute') {
    toast.error(
      remote
        ? translate(
            'auto.components.sidebar.WorktreeOpenInMenu.remotePathInvalid',
            'Path is not valid for the SSH host.'
          )
        : translate(
            'auto.components.sidebar.WorktreeOpenInMenu.f387af445b',
            'Workspace path is not a valid local path.'
          ),
      remote
        ? {
            description: translate(
              'auto.components.sidebar.WorktreeOpenInMenu.remotePathInvalidDetail',
              'Refresh the workspace before trying again.'
            )
          }
        : undefined
    )
    return
  }
  if (result.reason === 'not-found') {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.3921d3d9a5',
        'Workspace folder was not found.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.0bed8727db',
          'It may have been moved or deleted. Refresh workspaces or remove it from Orca.'
        )
      }
    )
    return
  }
  if (remote) {
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeOpenInMenu.remoteLaunchFailed',
        'Could not open the remote workspace.'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeOpenInMenu.remoteLaunchFailedDetail',
          'Check the editor command configured on this machine.'
        )
      }
    )
    return
  }
  toast.error(
    translate(
      'auto.components.sidebar.WorktreeOpenInMenu.9a5381eb09',
      'Could not open workspace folder.'
    ),
    {
      description: translate(
        'auto.components.sidebar.WorktreeOpenInMenu.bd0e8159f8',
        'Check the editor command or file manager configuration on this machine.'
      )
    }
  )
}
