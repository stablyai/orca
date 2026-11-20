import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { createWorktreeOnRuntimeHost, type HostCreateSettings } from './host-planned-agent-launch'
import { adoptRuntimeProvisionedRoot } from './runtime-provisioned-root-adoption'
import { isRuntimeLineageParentMissingError } from '../listing/runtime-worktree-rpc-errors'
import {
  buildLocalWorktreeCreateArgs,
  type CreatedWorktreeResult,
  type WorktreeCreateAttempt,
  type WorktreeCreateRequest
} from './worktree-create-payload'
import { withoutRefusedInferredParent } from './worktree-create-cross-store-parent'
import type { CreateAttemptOutcome } from './worktree-create-parent-pick'

/** One create on its host; a refused inferred parent retries unnested, a missing one drops the parent. */
export async function runCreateAttempt(
  request: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt,
  target: RuntimeClientTarget,
  settings: HostCreateSettings
): Promise<CreateAttemptOutcome> {
  const provisionedRoot = request.options?.provisionedRoot
  const create = async (
    parentWorkspace: WorktreeCreateAttempt['parentWorkspace']
  ): Promise<CreatedWorktreeResult> =>
    provisionedRoot
      ? target.kind === 'environment'
        ? await adoptRuntimeProvisionedRoot(
            target,
            request,
            { ...attempt, parentWorkspace },
            provisionedRoot
          )
        : await window.api.worktrees.adoptProvisionedRoot({
            ...buildLocalWorktreeCreateArgs(request, { ...attempt, parentWorkspace }),
            ...provisionedRoot
          })
      : target.kind === 'local'
        ? // Why local can still reject on the parent: paired web clients route this API to their host.
          await window.api.worktrees.create(
            buildLocalWorktreeCreateArgs(request, { ...attempt, parentWorkspace })
          )
        : await createWorktreeOnRuntimeHost(
            target.environmentId,
            request,
            { ...attempt, parentWorkspace },
            settings
          )
  try {
    return { result: await create(attempt.parentWorkspace), droppedParent: false }
  } catch (error) {
    const unnested = withoutRefusedInferredParent(attempt, error)
    if (unnested) {
      return await runCreateAttempt(request, unnested, target, settings)
    }
    if (!attempt.parentWorkspace || !isRuntimeLineageParentMissingError(error)) {
      throw error
    }
    return { result: await create(undefined), droppedParent: true }
  }
}
