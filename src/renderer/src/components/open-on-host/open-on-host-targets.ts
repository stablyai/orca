import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host/execution-host-registry-entry'
import type { ProjectHostSetup } from '../../../../shared/project/project-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { WORKTREE_OPEN_EXISTING_BRANCH_V2_REQUEST_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  buildProjectHostSetupOptions,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/workspace/creation/project-host-setup-options'

export type OpenOnHostTarget = {
  hostId: ExecutionHostId
  environmentId: string
  label: string
  /** The project's ready location on that host, or null (clone needed). */
  existingSetup: ReadyProjectHostSetupOption | null
  disabledReason: string | null
}

export type OpenOnHostTargetsInput = {
  projectId: string
  sourceHostId: ExecutionHostId
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
  hosts: readonly ExecutionHostRegistryEntry[]
  cloneUrl: string
  /** Workspace items need `open-existing-v2` on the host. */
  requireBranchReuse: boolean
}

export function listOpenOnHostTargets(
  input: OpenOnHostTargetsInput,
  t: Translate = translate
): OpenOnHostTarget[] {
  const { projectId, sourceHostId, projectHostSetups, eligibleRepos, hosts } = input
  const hostById = new Map(hosts.map((host) => [host.id, host]))
  const targets: OpenOnHostTarget[] = []
  for (const option of buildProjectHostSetupOptions({
    projectId,
    projectHostSetups,
    eligibleRepos,
    hosts
  })) {
    const parsed = parseExecutionHostId(option.hostId)
    const host = hostById.get(option.hostId)
    if (
      parsed?.kind !== 'runtime' ||
      option.hostId === sourceHostId ||
      host?.aliasHostIds?.includes(sourceHostId)
    ) {
      continue
    }
    targets.push({
      hostId: option.hostId,
      environmentId: parsed.environmentId,
      label: option.label,
      existingSetup: option.kind === 'ready' ? option : null,
      disabledReason: getDisabledReason(option, host, input, t)
    })
  }
  return targets
}

function getDisabledReason(
  option: ProjectHostSetupOption,
  host: ExecutionHostRegistryEntry | undefined,
  { cloneUrl, requireBranchReuse }: OpenOnHostTargetsInput,
  t: Translate
): string | null {
  if (option.kind === 'needs-setup' && !option.canSetLocation) {
    return option.detail
  }
  if (!cloneUrl) {
    return t('openOnHost.noRemote', 'Add a git remote to open this project on another machine')
  }
  if (
    requireBranchReuse &&
    !host?.capabilities?.includes(WORKTREE_OPEN_EXISTING_BRANCH_V2_REQUEST_RUNTIME_CAPABILITY)
  ) {
    return t('openOnHost.updateOrca', 'Update Orca on {{host}} to use this', {
      host: option.label
    })
  }
  return null
}
