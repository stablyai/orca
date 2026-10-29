/**
 * The move dialog's entry points (host row, project menu, project runtime setting). Each is
 * offered only where WSL hosts are: the internal gate open (the preload omits the API otherwise)
 * and the Experimental switch on. Main refuses every call with the gate closed regardless.
 */
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { WslMoveRowRef } from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  useWslHostsAcceptNewWork,
  useWslHostServerFilesMissing
} from '../sidebar/use-wsl-hosts-enabled'
import { openWslMoveDialog } from './wsl-move-dialog-store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { wslMoveCatalogCandidates, wslMoveTargetForRepo } from './wsl-move-scope-rows'

export function openWslMoveDialogFor(distro: string, only?: WslMoveRowRef): void {
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

/** The distro host a local WSL repo can move to, or null where no move is offered. */
export function useWslMoveTargetForRepo(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'> | null | undefined
): string | null {
  const enabled = useWslHostsAcceptNewWork()
  const serverFilesMissing = useWslHostServerFilesMissing()
  const environments = useAppStore((s) => s.runtimeEnvironments)
  return enabled && !serverFilesMissing && repo ? wslMoveTargetForRepo(repo, environments) : null
}
