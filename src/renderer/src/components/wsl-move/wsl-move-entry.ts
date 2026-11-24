/**
 * The move dialog's entry points (host row, project menu, project runtime setting). Each is
 * offered only where WSL hosts are: the internal gate open (the preload omits the API otherwise)
 * and the Experimental switch on. Main refuses every call with the gate closed regardless.
 */
import { useAppStore } from '@/store'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import { wslHostMovableDistroOfPath } from '../../../../shared/file-access/wsl-paths'
import { wslMappedDrivePathToShare } from '../../../../shared/wsl-move/wsl-mapped-drive-paths'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WslMoveRowRef } from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  useWslHostsAcceptNewWork,
  useWslHostServerFilesMissing
} from '../../runtime/hosts/wsl/use-wsl-hosts-enabled'
import { useWslMappedDriveShare } from './wsl-mapped-drive-share-store'
import { openWslMoveDialog } from './wsl-move-dialog-store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { findWslHostForDistro, wslMoveCatalogCandidates } from './wsl-move-scope-rows'

/** `only`: the projects that start checked; absent, every project of the distro does. */
export function openWslMoveDialogFor(
  distro: string,
  only?: WslMoveRowRef | readonly WslMoveRowRef[]
): void {
  void openWslMoveDialog({
    distro,
    only,
    catalogCandidates: () => {
      const state = useAppStore.getState()
      return wslMoveCatalogCandidates(
        { repos: state.repos, folders: selectFolderWorkspaces(state) },
        distro
      )
    }
  })
}

/** Where a local project can move: its distro's host, spelled as the host names the distro. */
export type WslMoveTarget = {
  distro: string
  /** Saved under a drive letter mapped to the distro's share; main reads that mapping itself. */
  viaMappedDrive?: boolean
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/
/** The host a local project's folder could move to, or null where no move is offered. */
export function useWslMoveTargetForPath(
  path: string | null | undefined,
  isLocal: boolean
): WslMoveTarget | null {
  const enabled = useWslHostsAcceptNewWork()
  const serverFilesMissing = useWslHostServerFilesMissing()
  const environments = useAppStore((s) => s.runtimeEnvironments)
  const offered = enabled && !serverFilesMissing && isLocal && path ? path : null
  const share = useWslMappedDriveShare(offered)
  return offered ? wslMoveTargetOfPath(offered, share, environments) : null
}

/** `share` is the share a drive-letter `path`'s drive maps to, else null. */
export function wslMoveTargetOfPath(
  path: string,
  share: string | null,
  environments: Parameters<typeof findWslHostForDistro>[0]
): WslMoveTarget | null {
  const uncDistro = wslHostMovableDistroOfPath(path)
  const letter = path[0]?.toUpperCase() ?? ''
  const sharePath =
    uncDistro || !share || !DRIVE_PATH.test(path)
      ? null
      : wslMappedDrivePathToShare(path, { letter, share })
  const distro = uncDistro ?? (sharePath ? wslHostMovableDistroOfPath(sharePath) : null)
  const host = distro ? findWslHostForDistro(environments, distro) : null
  if (!host) {
    return null
  }
  return sharePath ? { distro: host.distro, viaMappedDrive: true } : { distro: host.distro }
}

/** The distro host a local WSL repo can move to, or null where no move is offered. */
export function useWslMoveTargetForRepo(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'> | null | undefined
): WslMoveTarget | null {
  return useWslMoveTargetForPath(
    repo?.path,
    !!repo && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
  )
}
