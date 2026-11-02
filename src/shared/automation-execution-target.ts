import type { Automation, AutomationExecutionTargetType } from './automations-types'
import type { Repo } from './repo-types'
import { getRepoSshConnectionId } from './execution-host'
import type { AutomationWorkspaceSshPin } from './automation-workspace-pin'

/** Fail closed when project resolution misses: create refuses; update retains the target unless explicitly moved. Capture SSH registration generations even through local folder-workspace pins so same-ID re-registration cannot impersonate the chosen host. */

export type AutomationExecutionTargetSelection = {
  executionTargetType: AutomationExecutionTargetType
  executionTargetId: string
  executionTargetGeneration?: number
}

export type AutomationExecutionTargetRepo = Pick<Repo, 'connectionId' | 'executionHostId'>

export type AutomationStoredExecutionTarget = Pick<
  Automation,
  'executionTargetType' | 'executionTargetId' | 'executionTargetGeneration'
>

export const MISSING_AUTOMATION_PROJECT_ERROR =
  "This automation's project no longer exists, so its host cannot be resolved."

function withGeneration(
  selection: Omit<AutomationExecutionTargetSelection, 'executionTargetGeneration'>,
  generation: number | undefined
): AutomationExecutionTargetSelection {
  return {
    ...selection,
    ...(generation === undefined ? {} : { executionTargetGeneration: generation })
  }
}

function selectionForRepo(
  repo: AutomationExecutionTargetRepo,
  sshTargetGeneration: number | undefined,
  workspaceSshPin: AutomationWorkspaceSshPin | undefined
): AutomationExecutionTargetSelection {
  const connectionId = getRepoSshConnectionId(repo)
  if (!connectionId) {
    // A pinned workspace is the record's real host, so the local target captures its generation.
    return withGeneration(
      { executionTargetType: 'local', executionTargetId: 'local' },
      workspaceSshPin?.generation
    )
  }
  return withGeneration(
    { executionTargetType: 'ssh', executionTargetId: connectionId },
    sshTargetGeneration
  )
}

/** Clear stale generation when moving off SSH, but retain workspace-pin evidence even if currently unregistered; otherwise same-ID re-registration impersonates the chosen host. */
export function applyAutomationExecutionTarget<T extends AutomationStoredExecutionTarget>(
  record: T,
  selection: AutomationExecutionTargetSelection,
  retainedWorkspaceSshPin?: AutomationWorkspaceSshPin
): T {
  const next = { ...record, ...selection }
  if (selection.executionTargetGeneration === undefined && !retainedWorkspaceSshPin) {
    delete next.executionTargetGeneration
  }
  return next
}

/** Create fails closed: an automation with no resolvable project has no derivable host. */
export function deriveAutomationExecutionTargetForCreate(input: {
  repo: AutomationExecutionTargetRepo | undefined
  sshTargetGeneration: number | undefined
  workspaceSshPin?: AutomationWorkspaceSshPin
}): AutomationExecutionTargetSelection {
  if (!input.repo) {
    throw new Error(MISSING_AUTOMATION_PROJECT_ERROR)
  }
  return selectionForRepo(input.repo, input.sshTargetGeneration, input.workspaceSshPin)
}

/** Re-derive only on explicit moves and refuse unresolved projects. Resolving a repo alone cannot re-adopt orphans onto current registrations or erase captured generations during pause. */
export function deriveAutomationExecutionTargetForUpdate(input: {
  current: AutomationStoredExecutionTarget
  repo: AutomationExecutionTargetRepo | undefined
  /** An explicit `projectId` or an explicit destination; nothing else moves a selector. */
  selectorMoveRequested: boolean
  sshTargetGeneration: number | undefined
  /** The SSH target the record's workspace pins it to once the update lands. */
  workspaceSshPin?: AutomationWorkspaceSshPin
  /** The update re-points the record at a different pinned target, or off one entirely. */
  workspaceSshPinMoved?: boolean
}): AutomationExecutionTargetSelection {
  if (!input.selectorMoveRequested) {
    // Re-pointing the workspace moves a local record's host, so its capture moves with it.
    const generation =
      input.current.executionTargetType === 'local' && input.workspaceSshPinMoved
        ? input.workspaceSshPin?.generation
        : input.current.executionTargetGeneration
    return withGeneration(
      {
        executionTargetType: input.current.executionTargetType,
        executionTargetId: input.current.executionTargetId
      },
      generation
    )
  }
  if (!input.repo) {
    throw new Error(MISSING_AUTOMATION_PROJECT_ERROR)
  }
  return selectionForRepo(input.repo, input.sshTargetGeneration, input.workspaceSshPin)
}
