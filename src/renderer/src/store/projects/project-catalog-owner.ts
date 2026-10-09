import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host'

function catalogOwnerForExecutionHost(hostId: string): string {
  return parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : LOCAL_EXECUTION_HOST_ID
}

export function getRepoCatalogOwnerHostId(repo: Repo): string {
  return repo.catalogOwnerHostId ?? catalogOwnerForExecutionHost(getRepoExecutionHostId(repo))
}

export function getSetupCatalogOwnerHostId(setup: ProjectHostSetup): string {
  return setup.catalogOwnerHostId ?? catalogOwnerForExecutionHost(setup.hostId)
}
