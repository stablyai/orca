import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  CloudSshEditor,
  CloudSshErrorCode,
  CloudSshFailure,
  CloudSshStatus
} from '../../../../../../shared/cloud-ssh'
import { noteCloudSshAccess, noteCloudSshInclude } from './use-cloud-ssh-status'

type ToastId = string | number

// One setup per workspace at a time: a second click joins the running one.
const inFlight = new Map<string, Promise<void>>()

function once(key: string, run: () => Promise<void>): Promise<void> {
  const running = inFlight.get(key)
  if (running) {
    return running
  }
  const next = run().finally(() => inFlight.delete(key))
  inFlight.set(key, next)
  return next
}

function failureText(code: CloudSshErrorCode): { title: string; description: string } {
  switch (code) {
    case 'unsupported_image':
      return {
        title: translate(
          'auto.components.sidebar.CloudSsh.unsupportedImage',
          'SSH isn’t available here'
        ),
        description: translate(
          'auto.components.sidebar.CloudSsh.unsupportedImageDetail',
          'This workspace was created before Orca Cloud supported SSH. New workspaces have it.'
        )
      }
    case 'asleep':
      return {
        title: translate('auto.components.sidebar.CloudSsh.asleep', 'The workspace went to sleep'),
        description: translate(
          'auto.components.sidebar.CloudSsh.asleepDetail',
          'Try again to wake it.'
        )
      }
    case 'wake_failed':
      return {
        title: translate(
          'auto.components.sidebar.CloudSsh.wakeFailed',
          'Couldn’t wake the workspace'
        ),
        description: translate(
          'auto.components.sidebar.CloudSsh.wakeFailedDetail',
          'Try again in a moment.'
        )
      }
    case 'editor_missing':
      return {
        title: translate('auto.components.sidebar.CloudSsh.editorMissing', 'Editor not found'),
        description: translate(
          'auto.components.sidebar.CloudSsh.editorMissingDetail',
          'Reinstall it, or open the workspace in the other editor.'
        )
      }
    case 'forward_failed':
      return {
        title: translate('auto.components.sidebar.CloudSsh.failed', 'Couldn’t set up SSH'),
        description: translate(
          'auto.components.sidebar.CloudSsh.forwardFailedDetail',
          'Orca couldn’t reach the workspace. Check your connection and try again.'
        )
      }
    case 'not_found':
    case 'not_cloud':
    case 'not_configured':
    case 'cli_missing':
    case 'control_plane':
      return {
        title: translate('auto.components.sidebar.CloudSsh.failed', 'Couldn’t set up SSH'),
        description: translate(
          'auto.components.sidebar.CloudSsh.failedDetail',
          'Orca Cloud didn’t answer. Try again in a moment.'
        )
      }
  }
}

function showFailure(
  toastId: ToastId | undefined,
  failure: CloudSshFailure,
  retry?: () => void
): void {
  console.warn(`[cloud-ssh] ${failure.code}: ${failure.message}`)
  const { title, description } = failureText(failure.code)
  toast.error(title, {
    id: toastId,
    description,
    ...(retry && failure.code !== 'unsupported_image'
      ? {
          action: {
            label: translate('auto.components.sidebar.CloudSsh.retry', 'Retry'),
            onClick: retry
          }
        }
      : {})
  })
}

const thrown: CloudSshFailure = { ok: false, code: 'control_plane', message: '' }

/** Progress for anything that can wait: at once for a wake or a first key install, otherwise
 *  only if the call outlasts 400 ms (a stale status). Returns the toast id to settle, if shown. */
function startProgress(
  status: Pick<CloudSshStatus, 'hasAccess' | 'asleep'>
): () => ToastId | undefined {
  let id: ToastId | undefined
  const show = (title: string, description?: string): void => {
    id = toast.loading(title, description ? { description } : undefined)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  if (!status.hasAccess) {
    show(
      translate('auto.components.sidebar.CloudSsh.settingUp', 'Setting up SSH…'),
      status.asleep
        ? translate('auto.components.sidebar.CloudSsh.waking', 'Waking the workspace…')
        : translate('auto.components.sidebar.CloudSsh.addingKey', 'Adding this computer’s key…')
    )
  } else if (status.asleep) {
    show(translate('auto.components.sidebar.CloudSsh.wakingTitle', 'Waking the workspace…'))
  } else {
    timer = setTimeout(
      () => show(translate('auto.components.sidebar.CloudSsh.preparing', 'Preparing SSH…')),
      400
    )
  }
  return () => {
    clearTimeout(timer)
    return id
  }
}

export function copyCloudSshCommand(workspaceId: string, status: CloudSshStatus): Promise<void> {
  return once(`copy:${workspaceId}`, async () => {
    const settle = startProgress(status)
    const result = await window.api.ephemeralVm
      .cloudSshCopyCommand({ workspaceId })
      .catch(() => thrown)
    const toastId = settle()
    if (!result.ok) {
      showFailure(toastId, result, () => void copyCloudSshCommand(workspaceId, status))
      return
    }
    noteCloudSshAccess(workspaceId, true)
    toast.success(translate('auto.components.sidebar.CloudSsh.copied', 'SSH command copied'), {
      id: toastId,
      description: (
        <code className="font-mono text-2xs [overflow-wrap:anywhere]">{result.displayCommand}</code>
      )
    })
  })
}

export function openCloudWorkspaceInEditor(args: {
  workspaceId: string
  editor: CloudSshEditor
  status: CloudSshStatus
  allowSshConfigInclude: boolean
}): Promise<void> {
  return once(`open:${args.workspaceId}:${args.editor.id}`, async () => {
    const settle = startProgress(args.status)
    const result = await window.api.ephemeralVm
      .cloudSshOpenInEditor({
        workspaceId: args.workspaceId,
        editorId: args.editor.id,
        allowSshConfigInclude: args.allowSshConfigInclude
      })
      .catch(() => thrown)
    const toastId = settle()
    if (result.ok) {
      noteCloudSshAccess(args.workspaceId, true)
      toast.success(
        translate('auto.components.sidebar.CloudSsh.opening', 'Opening in {{editor}}', {
          editor: args.editor.label
        }),
        {
          id: toastId,
          description: translate(
            'auto.components.sidebar.CloudSsh.openingDetail',
            'The first connection can take a minute.'
          )
        }
      )
      return
    }
    if (result.code === 'include_required') {
      if (toastId !== undefined) {
        toast.dismiss(toastId)
      }
      useAppStore.getState().openModal('confirm-cloud-ssh-include', {
        workspaceId: args.workspaceId,
        editor: args.editor,
        status: args.status,
        includeLine: result.includeLine
      })
      return
    }
    showFailure(toastId, result, () => void openCloudWorkspaceInEditor(args))
  })
}

export function revokeCloudSshAccess(workspaceId: string): Promise<void> {
  return once(`revoke:${workspaceId}`, async () => {
    const toastId = toast.loading(
      translate('auto.components.sidebar.CloudSsh.revoking', 'Revoking SSH access…')
    )
    const result = await window.api.ephemeralVm.cloudSshRevoke({ workspaceId }).catch(() => thrown)
    if (!result.ok) {
      showFailure(toastId, result)
      return
    }
    noteCloudSshAccess(workspaceId, false)
    toast.success(translate('auto.components.sidebar.CloudSsh.revoked', 'SSH access revoked'), {
      id: toastId,
      description: result.removedFromWorkspace
        ? translate(
            'auto.components.sidebar.CloudSsh.revokedDetail',
            'This computer can no longer connect.'
          )
        : translate(
            'auto.components.sidebar.CloudSsh.revokedUnreachableDetail',
            'Deleted here. Orca couldn’t reach the workspace, so its copy is removed the next time this computer connects.'
          )
    })
  })
}

export async function removeCloudSshConfigInclude(): Promise<void> {
  const removed = await window.api.ephemeralVm.cloudSshRemoveSshConfigInclude().catch(() => false)
  if (!removed) {
    toast.error(
      translate(
        'auto.components.sidebar.CloudSsh.includeRemoveFailed',
        'Couldn’t edit ~/.ssh/config'
      )
    )
    return
  }
  noteCloudSshInclude(false)
  toast.success(
    translate('auto.components.sidebar.CloudSsh.includeRemoved', 'Removed from ~/.ssh/config'),
    {
      description: translate(
        'auto.components.sidebar.CloudSsh.includeRemovedDetail',
        'Editors no longer see Orca Cloud hosts. Opening one in an editor asks again.'
      )
    }
  )
}
