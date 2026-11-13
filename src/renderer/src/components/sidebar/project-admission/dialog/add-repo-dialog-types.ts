import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WslHostWindowsDriveRefusal } from '../../../../../../shared/wsl-host-windows-drive-refusal'

export type AddRepoDialogStep = 'add' | 'clone' | 'remote' | 'server-path' | 'create' | 'nested'

export type AddProjectMenuAction = 'browse' | 'clone' | 'create'

export type AddRepoDialogEntryRequest =
  | {
      id: number
      kind: 'clone' | 'create' | 'browse-runtime'
      hostId: ExecutionHostId | null
    }
  | {
      id: number
      kind: 'picked-local-paths'
      paths: readonly string[]
      hostId: ExecutionHostId
    }
  | {
      id: number
      kind: 'picked-wsl-host-path'
      hostId: ExecutionHostId
      path: string
    }
  | {
      id: number
      kind: 'wsl-windows-drive-refusal'
      hostId: ExecutionHostId
      refusal: WslHostWindowsDriveRefusal
    }

export function defaultProjectGroupNameForPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/g, '')
      .split(/[\\/]/)
      .findLast(Boolean) ?? path
  )
}

export function createNestedRepoScanId(): string {
  return `nested-repo-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
