import type { Automation, AutomationExecutionTargetType } from './automations-types'
import type { AutomationWorkspaceSshPin } from './automation-workspace-pin'

/**
 * Decides which execution target an automation is stored against.
 *
 * The old rule (`repo?.connectionId ? 'ssh' : 'local'`) silently wrote the
 * literal `local` whenever the repo lookup missed, so deleting a project turned
 * an SSH automation into a local one that would then run on the wrong host.
 * Both paths now fail closed instead: create refuses an unresolvable project,
 * and update preserves the stored selector unless the caller explicitly asked
 * to move the record to a project that does resolve.
 *
 * A `local` record whose folder workspace pins it to an SSH host captures that
 * registration's generation too. Without a capture, `captured ?? current` always
 * reads the *current* generation, so a host removed and re-added under the same
 * id can never be told from the one the user chose.
 */

export type AutomationExecutionTargetSelection = {
  executionTargetType: AutomationExecutionTargetType
  executionTargetId: string
  executionTargetGeneration?: number
}

export type AutomationExecutionTargetRepo = { connectionId?: string | null }

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
  const connectionId = repo.connectionId?.trim()
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

/**
 * Apply a derived selection, clearing a stale generation when the record moves
 * off SSH.
 *
 * `retainedWorkspaceSshPin` is the pin the record keeps across the move. Its
 * capture is evidence of one registration incarnation and survives even when the
 * pinned target is currently unregistered — dropping it there would let a later
 * same-id registration read as the host the user chose.
 */
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

/**
 * Update re-derives only when the caller asked to move the record, and then
 * fails closed on an unresolvable project.
 *
 * A resolved repo is not a request to move: re-deriving from it re-adopts an
 * orphan onto whatever registration that repo points at today — which pause,
 * still enabled on orphans, would silently do — and strips a captured
 * generation whenever the current target has none.
 */
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
