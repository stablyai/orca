import { toast } from 'sonner'
import {
  classifyRejectedWindowsPath,
  type WindowsPathAccess
} from '../../../../shared/windows-path-access'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  wslHostWindowsDriveRefusalForPickedPath,
  type WslHostWindowsDriveRefusal
} from '../../../../shared/wsl-host-windows-drive-refusal'
import { translate } from '@/i18n/i18n'

export type DroppedHostPath = { hostId: ExecutionHostId; path: string }

export function readDroppedHostPath(modalData: Record<string, unknown>): DroppedHostPath | null {
  const value = modalData.droppedHostPath
  if (typeof value !== 'object' || value === null || !('hostId' in value) || !('path' in value)) {
    return null
  }
  const hostId = typeof value.hostId === 'string' ? normalizeExecutionHostId(value.hostId) : null
  return hostId && typeof value.path === 'string' && value.path
    ? { hostId, path: value.path }
    : null
}

type WslHostFolderPickerDeps = {
  /** The host's Linux home, where the picker opens; null when the host could not say. */
  readHome: () => Promise<string | null>
  pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
  /** The folder is on a Windows drive, which this computer should own; the dialog shows it inline. */
  onWindowsDriveRefusal: (refusal: WslHostWindowsDriveRefusal) => void
}

/** Browse the distro through Windows UNC paths, returning Linux paths or null on cancel/refusal. */
export async function pickWslHostFolder(
  access: WindowsPathAccess,
  deps: WslHostFolderPickerDeps
): Promise<string | null> {
  const home = await deps.readHome().catch(() => null)
  const defaultPath = access.toWindows(home ?? '/') ?? access.toWindows('/')
  const picked = await deps.pickDirectory(defaultPath ? { defaultPath } : {})
  if (!picked) {
    return null
  }
  const driveRefusal = wslHostWindowsDriveRefusalForPickedPath(picked)
  if (driveRefusal) {
    deps.onWindowsDriveRefusal(driveRefusal)
    return null
  }
  const linuxPath = access.fromWindows(picked)
  if (linuxPath) {
    return linuxPath
  }
  const rejection = classifyRejectedWindowsPath(picked)
  if (rejection.kind === 'windows-drive') {
    return null
  }
  showWslHostFolderRefusal(rejection, access.wslDistro)
  return null
}

function showWslHostFolderRefusal(
  rejection: Exclude<ReturnType<typeof classifyRejectedWindowsPath>, { kind: 'windows-drive' }>,
  distro: string
): void {
  const title =
    rejection.kind === 'other-distro'
      ? translate(
          'auto.components.sidebar.addRepoWslHostFolderPicker.otherDistro',
          'That folder is in {{value0}}, not {{value1}}.',
          { value0: rejection.distro, value1: distro }
        )
      : translate(
          'auto.components.sidebar.addRepoWslHostFolderPicker.outsideDistro',
          'Pick a folder inside {{value0}}.',
          { value0: distro }
        )
  const description = translate(
    'auto.components.sidebar.addRepoWslHostFolderPicker.underDistro',
    'This host can only add folders under \\\\wsl.localhost\\{{value0}}.',
    { value0: distro }
  )
  toast.error(title, { description })
}
