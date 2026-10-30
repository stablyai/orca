/** Keep owner capture optional for legacy wire clients; current clients echo it for strict read/write/execute fencing. */

import type { Automation } from './automations-types'
import type { AutomationExecutionTargetSelection } from './automation-execution-target'
import type { AutomationWorkspaceSshPin } from './automation-workspace-pin'
import {
  projectAutomationSelector,
  type AutomationListItemSelector,
  type AutomationProjectionContext
} from './automation-list-scope'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from './automation-owner-conflict'
import { sanitizeSshTargetGeneration } from './ssh-target-generation'

export type AutomationOwnerPreconditionSelector =
  | { kind: 'self' }
  | { kind: 'ssh'; targetId: string; targetGeneration: number }
  | { kind: 'orphan' }

export type AutomationOwnerPrecondition = {
  selector: AutomationOwnerPreconditionSelector
}

/** Where a create or a selector-moving update wants the record to land. */
export type AutomationDestination = {
  selector: { kind: 'self' } | { kind: 'ssh'; targetId: string; targetGeneration: number }
}

export type AutomationOwnerFenceOperation = 'read' | 'mutate' | 'execute'

/** Echo captured host identity, omitting orphan diagnosis: ownership and why its host is unusable are separate claims. */
export function toAutomationOwnerPrecondition(
  selector: AutomationListItemSelector
): AutomationOwnerPrecondition {
  return {
    selector:
      selector.kind === 'ssh'
        ? {
            kind: 'ssh',
            targetId: selector.targetId,
            targetGeneration: selector.targetGeneration
          }
        : { kind: selector.kind }
  }
}

export type AutomationOwnerFenceInput = {
  automation: Automation
  expectedOwner?: AutomationOwnerPrecondition
  operation: AutomationOwnerFenceOperation
  context: AutomationProjectionContext
}

function conflict(code: keyof typeof AUTOMATION_OWNER_CONFLICT_CODES): never {
  throw new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES[code])
}

export function assertAutomationOwnerFence(input: AutomationOwnerFenceInput): void {
  const stored = projectAutomationSelector(input.automation, input.context)
  const expected = input.expectedOwner?.selector
  if (stored.kind === 'orphan' && input.operation === 'execute') {
    conflict('targetRemoved')
  }
  if (!expected) {
    // Require owner capture for fenced SSH mutations/execution; only reads, Self and generation-less legacy SSH remain callable bare.
    if (
      input.operation !== 'read' &&
      stored.kind === 'ssh' &&
      sanitizeSshTargetGeneration(input.automation.executionTargetGeneration) !== undefined
    ) {
      conflict('fencingRequired')
    }
    return
  }
  if (expected.kind !== stored.kind) {
    conflict('ownerChanged')
  }
  if (
    expected.kind === 'ssh' &&
    stored.kind === 'ssh' &&
    (expected.targetId !== stored.targetId || expected.targetGeneration !== stored.targetGeneration)
  ) {
    conflict('ownerChanged')
  }
}

/** A destination is resolved against the saved target registry, never accepted as a free-form value. */
export function assertAutomationDestination(
  destination: AutomationDestination,
  context: Pick<AutomationProjectionContext, 'sshTargetGeneration'>
): void {
  const selector = destination.selector
  if (selector.kind === 'self') {
    return
  }
  if (selector.kind !== 'ssh' || !selector.targetId) {
    conflict('invalidDestination')
  }
  if (context.sshTargetGeneration(selector.targetId) !== selector.targetGeneration) {
    conflict('invalidDestination')
  }
}

/** Use the projected selector: local-stored records pinned to SSH actually execute at that registration. */
function landingSelector(
  selection: AutomationExecutionTargetSelection,
  workspaceSshPin: AutomationWorkspaceSshPin | undefined
): { kind: 'self' } | { kind: 'ssh'; targetId: string; targetGeneration: number | undefined } {
  if (selection.executionTargetType === 'ssh') {
    return {
      kind: 'ssh',
      targetId: selection.executionTargetId,
      targetGeneration: selection.executionTargetGeneration
    }
  }
  if (selection.executionTargetType === 'local' && workspaceSshPin) {
    return {
      kind: 'ssh',
      targetId: workspaceSshPin.targetId,
      targetGeneration: selection.executionTargetGeneration ?? workspaceSshPin.generation
    }
  }
  return { kind: 'self' }
}

/** The host the record actually lands on must be the one the caller chose. */
export function assertExecutionTargetMatchesDestination(
  selection: AutomationExecutionTargetSelection,
  destination: AutomationDestination,
  /** The SSH target the record's workspace pins it to once the write lands. */
  workspaceSshPin?: AutomationWorkspaceSshPin
): void {
  const landing = landingSelector(selection, workspaceSshPin)
  const selector = destination.selector
  if (selector.kind === 'self') {
    if (landing.kind !== 'self') {
      conflict('invalidDestination')
    }
    return
  }
  if (
    landing.kind !== 'ssh' ||
    landing.targetId !== selector.targetId ||
    (landing.targetGeneration ?? selector.targetGeneration) !== selector.targetGeneration
  ) {
    conflict('invalidDestination')
  }
}
