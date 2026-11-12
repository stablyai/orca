import { useAppStore } from '@/store/index'
import { getWindowsPathAccess } from '@/lib/files/os-open/windows-path-access'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { WslHostWindowsDriveRefusal } from '../../../../../../shared/wsl-host-windows-drive-refusal'
import type {
  AddProjectMenuAction,
  AddRepoDialogEntryRequest
} from '../dialog/add-repo-dialog-types'
import { pickWslHostFolder } from '../host-selection/add-repo-wsl-host-folder-picker'

let nextEntryRequestId = 1

function allocateEntryRequestId(): number {
  return nextEntryRequestId++
}

export async function launchAddProjectMenuAction({
  action,
  hostId,
  onOpenEntryRequest
}: {
  action: AddProjectMenuAction
  hostId: ExecutionHostId | null
  onOpenEntryRequest: (request: AddRepoDialogEntryRequest) => void
}): Promise<void> {
  if (!hostId) {
    return
  }
  if (action === 'clone') {
    onOpenEntryRequest({ id: allocateEntryRequestId(), kind: 'clone', hostId })
    return
  }
  if (action === 'create') {
    onOpenEntryRequest({ id: allocateEntryRequestId(), kind: 'create', hostId })
    return
  }

  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind === 'local') {
    const paths = await window.api.repos.pickFolders()
    if (paths.length === 0) {
      return
    }
    onOpenEntryRequest({
      id: allocateEntryRequestId(),
      kind: 'picked-local-paths',
      paths,
      hostId: LOCAL_EXECUTION_HOST_ID
    })
    return
  }

  if (parsedHost?.kind === 'runtime') {
    const runtimeEnvironments = useAppStore.getState().runtimeEnvironments
    const wslAccess = getWindowsPathAccess(hostId, runtimeEnvironments)
    if (wslAccess) {
      let windowsDriveRefusal: WslHostWindowsDriveRefusal | null = null
      const linuxPath = await pickWslHostFolder(wslAccess, {
        readHome: async () =>
          (await browseRuntimeServerDirectory(parsedHost.environmentId, '~')).resolvedPath,
        pickDirectory: (args) => window.api.shell.pickDirectory(args),
        onWindowsDriveRefusal: (refusal) => {
          windowsDriveRefusal = refusal
        }
      })
      if (windowsDriveRefusal) {
        onOpenEntryRequest({
          id: allocateEntryRequestId(),
          kind: 'wsl-windows-drive-refusal',
          hostId,
          refusal: windowsDriveRefusal
        })
        return
      }
      if (!linuxPath) {
        return
      }
      onOpenEntryRequest({
        id: allocateEntryRequestId(),
        kind: 'picked-wsl-host-path',
        hostId,
        path: linuxPath
      })
      return
    }

    onOpenEntryRequest({ id: allocateEntryRequestId(), kind: 'browse-runtime', hostId })
  }
}
