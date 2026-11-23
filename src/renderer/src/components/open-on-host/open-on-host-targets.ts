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
import { getHostHealthUnavailableDetail } from '@/lib/workspace/creation/project-host-health-detail'
import {
  buildProjectHostSetupOptions,
  getHostSetupUnavailableDetail,
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
    const host = hostById.get(option.hostId)
    const rpcHostId = getRuntimeHostId(option.hostId, host)
    const parsed = rpcHostId ? parseExecutionHostId(rpcHostId) : null
    if (
      !rpcHostId ||
      parsed?.kind !== 'runtime' ||
      option.hostId === sourceHostId ||
      rpcHostId === sourceHostId ||
      host?.aliasHostIds?.includes(sourceHostId) ||
      host?.mergedIntoHostId === sourceHostId
    ) {
      continue
    }
    targets.push({
      hostId: rpcHostId,
      environmentId: parsed.environmentId,
      label: option.label,
      existingSetup: option.kind === 'ready' ? option : null,
      disabledReason: getDisabledReason(option, hostById.get(rpcHostId), input, t)
    })
  }
  return targets
}

// Why: a managed server on the SSH relay shows as its ssh: row; RPCs still go to the runtime: alias.
function getRuntimeHostId(
  hostId: ExecutionHostId,
  host: ExecutionHostRegistryEntry | undefined
): ExecutionHostId | undefined {
  if (parseExecutionHostId(hostId)?.kind === 'runtime') {
    return hostId
  }
  return host?.aliasHostIds?.find((alias) => parseExecutionHostId(alias)?.kind === 'runtime')
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
  // Why: the options builder checks health only for needs-setup rows, and on the relay the shown
  // row is ssh:, so it never checked the server's setup capabilities either.
  const runtimeUnavailable = !host
    ? null
    : (getHostHealthUnavailableDetail(host.health) ??
      (option.kind === 'needs-setup' ? getHostSetupUnavailableDetail(host, t) : null))
  if (runtimeUnavailable) {
    return runtimeUnavailable
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
