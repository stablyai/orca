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
    const existingSetup =
      option.kind === 'ready' ? getRuntimeReadySetup(option, rpcHostId, projectHostSetups) : null
    targets.push({
      hostId: rpcHostId,
      environmentId: parsed.environmentId,
      label: option.label,
      existingSetup,
      disabledReason: getDisabledReason(option, hostById.get(rpcHostId), existingSetup, input, t)
    })
  }
  return targets
}

// Why: on the relay the shown ready row can be the ssh: one, whose repoId the server does not know;
// use the server's own setup at that path, or clone (null) when the server has none.
function getRuntimeReadySetup(
  option: ReadyProjectHostSetupOption,
  rpcHostId: ExecutionHostId,
  projectHostSetups: readonly ProjectHostSetup[]
): ReadyProjectHostSetupOption | null {
  if (option.hostId === rpcHostId) {
    return option
  }
  const runtimeSetup = projectHostSetups.find(
    (setup) =>
      setup.projectId === option.projectId &&
      setup.hostId === rpcHostId &&
      setup.setupState === 'ready' &&
      setup.path === option.path
  )
  return runtimeSetup
    ? { ...option, id: runtimeSetup.id, hostId: rpcHostId, repoId: runtimeSetup.repoId }
    : null
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
  existingSetup: ReadyProjectHostSetupOption | null,
  { cloneUrl, requireBranchReuse }: OpenOnHostTargetsInput,
  t: Translate
): string | null {
  if (option.kind === 'needs-setup' && !option.canSetLocation) {
    return option.detail
  }
  // Why: the options builder checks health only for needs-setup rows. Reusing a runtime-owned copy
  // needs no setup capability, but a clone does, and a blocked (incompatible) host takes neither.
  const needsSetupCapability = option.kind === 'needs-setup' || !existingSetup
  const runtimeUnavailable = !host
    ? null
    : (getHostHealthUnavailableDetail(host.health) ??
      (needsSetupCapability || host.health === 'blocked'
        ? getHostSetupUnavailableDetail(host, t)
        : null))
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
