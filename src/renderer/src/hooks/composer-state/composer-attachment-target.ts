import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { ComposerModel } from './composer-model'

type TargetInput = Pick<
  ComposerModel,
  | 'selectedProjectGroup'
  | 'selectedRepoPath'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoSettings'
  | 'connectionId'
>

export function resolveComposerAttachmentTarget(input: TargetInput) {
  const group = input.selectedProjectGroup
  const hostId = group ? getRepoExecutionHostId(group) : input.selectedRepoExecutionHostId
  const host = parseExecutionHostId(hostId)
  return {
    hostId,
    path: group ? group.parentPath : (input.selectedRepoPath ?? null),
    connectionId: group
      ? host?.kind === 'runtime'
        ? null
        : (group.connectionId ?? null)
      : input.connectionId,
    settings: {
      ...input.selectedRepoSettings,
      activeRuntimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
    }
  }
}
