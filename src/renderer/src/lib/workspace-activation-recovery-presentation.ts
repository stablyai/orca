import type { ExecutionHostId } from '../../../shared/execution-host'

export type WorkspaceActivationRecoveryPresentation = {
  workspaceKey: string
  executionHostId: ExecutionHostId
  attemptId: string
  kind: 'recovering' | 'blocked' | 'unexpected' | 'unverifiable' | 'producer-failed'
  detail?: string
  retry: () => void
}

const presentationsByTarget = new Map<string, WorkspaceActivationRecoveryPresentation>()
const listeners = new Set<() => void>()

function targetKey(workspaceKey: string, executionHostId: ExecutionHostId): string {
  return `${executionHostId}|${workspaceKey}`
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function publishWorkspaceActivationRecoveryPresentation(
  presentation: WorkspaceActivationRecoveryPresentation
): void {
  presentationsByTarget.set(
    targetKey(presentation.workspaceKey, presentation.executionHostId),
    presentation
  )
  notifyListeners()
}

export function clearWorkspaceActivationRecoveryPresentation(args: {
  workspaceKey: string
  executionHostId: ExecutionHostId
  attemptId?: string
}): void {
  const key = targetKey(args.workspaceKey, args.executionHostId)
  const current = presentationsByTarget.get(key)
  if (!current || (args.attemptId && current.attemptId !== args.attemptId)) {
    return
  }
  presentationsByTarget.delete(key)
  notifyListeners()
}

export function clearWorkspaceActivationRecoveryPresentations(args: {
  workspaceKey?: string
  executionHostId?: ExecutionHostId
}): void {
  let changed = false
  for (const [key, presentation] of presentationsByTarget) {
    if (
      (args.workspaceKey === undefined || presentation.workspaceKey === args.workspaceKey) &&
      (args.executionHostId === undefined || presentation.executionHostId === args.executionHostId)
    ) {
      presentationsByTarget.delete(key)
      changed = true
    }
  }
  if (changed) {
    notifyListeners()
  }
}

export function readWorkspaceActivationRecoveryPresentation(
  workspaceKey: string,
  executionHostId: ExecutionHostId
): WorkspaceActivationRecoveryPresentation | null {
  return presentationsByTarget.get(targetKey(workspaceKey, executionHostId)) ?? null
}

export function subscribeWorkspaceActivationRecoveryPresentation(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetWorkspaceActivationRecoveryPresentationsForTests(): void {
  clearWorkspaceActivationRecoveryPresentations({})
}
