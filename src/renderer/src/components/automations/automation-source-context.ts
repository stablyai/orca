import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { Automation } from '../../../../shared/automations-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'

export type RepoBackedAutomationSourceContext = TaskSourceContext & {
  provider: 'github' | 'gitlab'
}

export function getRepoBackedAutomationSourceContext(
  automation: Automation
): RepoBackedAutomationSourceContext | null {
  const context = automation.sourceContext
  return context?.provider === 'github' || context?.provider === 'gitlab'
    ? (context as RepoBackedAutomationSourceContext)
    : null
}

export function getRuntimeSourceHostAvailability(
  context: TaskSourceContext,
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    { status: RuntimeStatus | null; checkedAt: number }
  >
): TaskSourceHostAvailability | null {
  const parsed = parseExecutionHostId(context.hostId)
  if (parsed?.kind !== 'runtime') {
    return null
  }
  const entry = runtimeStatusByEnvironmentId.get(parsed.environmentId)
  if (!entry) {
    return {
      hostId: context.hostId,
      reason: 'checking-task-source-capability'
    }
  }
  if (!entry.status) {
    return { hostId: context.hostId, health: 'disconnected' }
  }
  if (entry.status.graphStatus !== 'ready') {
    return { hostId: context.hostId, health: 'connecting' }
  }
  const capabilities = entry.status.capabilities
  if (!capabilities) {
    return {
      hostId: context.hostId,
      reason: 'checking-task-source-capability'
    }
  }
  if (!capabilities.includes(TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY)) {
    return { hostId: context.hostId, reason: 'missing-task-source-capability' }
  }
  return null
}
