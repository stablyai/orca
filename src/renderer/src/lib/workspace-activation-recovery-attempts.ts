import type { ExecutionHostId } from '../../../shared/execution-host'

type ActivationAttemptIdentity = {
  workspaceKey: string
  executionHostId: ExecutionHostId
  attemptId: string
}

const latestAttemptIdByTarget = new Map<string, string>()

export function activationRecoveryTargetKey(identity: {
  workspaceKey: string
  executionHostId: ExecutionHostId
}): string {
  return `${identity.executionHostId}|${identity.workspaceKey}`
}

export function markLatestActivationRecoveryAttempt(identity: ActivationAttemptIdentity): void {
  latestAttemptIdByTarget.set(activationRecoveryTargetKey(identity), identity.attemptId)
}

export function readLatestActivationRecoveryAttempt(
  identity: ActivationAttemptIdentity
): string | undefined {
  return latestAttemptIdByTarget.get(activationRecoveryTargetKey(identity))
}

export function clearLatestActivationRecoveryAttempts(args: {
  workspaceKey?: string
  executionHostId?: ExecutionHostId
}): void {
  for (const key of latestAttemptIdByTarget.keys()) {
    const separator = key.indexOf('|')
    const executionHostId = key.slice(0, separator)
    const workspaceKey = key.slice(separator + 1)
    if (
      (args.workspaceKey === undefined || workspaceKey === args.workspaceKey) &&
      (args.executionHostId === undefined || executionHostId === args.executionHostId)
    ) {
      latestAttemptIdByTarget.delete(key)
    }
  }
}
