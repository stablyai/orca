import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { forgeCredentialTarget } from '@/runtime/forge-credential-target'
import { useAppStore } from '@/store'

/** The host that owns the panel's review: the workspace's own host, else its repo's. */
export function checksPanelOwnerHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  worktree: Pick<Worktree, 'hostId'> | null | undefined
): string {
  return worktree?.hostId || getRepoExecutionHostId(repo)
}

/** For a snapshotted target that carries only the repo id. */
export function repoOwnerHostIdForRepoId(repoId: string | undefined): string | undefined {
  const repo = repoId ? useAppStore.getState().repos.find((row) => row.id === repoId) : undefined
  return repo ? getRepoExecutionHostId(repo) : undefined
}

/** A failed checks/comments read, naming the machine that answered so a sign-in error is actionable. */
export function checksPanelLoadErrorMessage(error: unknown, ownerHostId: string): string {
  const detail = error instanceof Error ? error.message : String(error)
  let machine: string
  try {
    const target = forgeCredentialTarget({ repoOwnerExecutionHostId: ownerHostId })
    machine =
      target.kind === 'environment'
        ? selectExecutionHostDisplayLabel(
            useAppStore.getState(),
            toRuntimeExecutionHostId(target.environmentId)
          )
        : translate('auto.runtime.forgeCredentialTarget.thisComputer', 'this computer')
  } catch {
    return detail
  }
  return translate(
    'auto.components.right.sidebar.checks.panel.loadFailedOnMachine',
    'Could not load from {{machine}}: {{detail}}',
    { machine, detail }
  )
}
