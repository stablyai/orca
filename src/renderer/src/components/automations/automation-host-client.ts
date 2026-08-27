import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

type RuntimeAutomationCreateInput = Omit<
  AutomationCreateInput,
  'projectId' | 'workspaceId' | 'timezone'
> & {
  repo?: string
  workspace?: string
  timezone?: string
}

type RuntimeAutomationUpdateInput = Omit<AutomationUpdateInput, 'projectId' | 'workspaceId'> & {
  repo?: string
  workspace?: string
}

export type AutomationHostTarget =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string }

export function getAutomationHostTargetKey(target: AutomationHostTarget): string {
  return target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
}

export function getAutomationHostTargetFromKey(key: string | null): AutomationHostTarget | null {
  if (!key) {
    return null
  }
  if (key.startsWith('environment:')) {
    return { kind: 'environment', environmentId: key.slice('environment:'.length) }
  }
  return { kind: 'local' }
}

export function getAutomationTargetFromHostId(
  hostId: string | null | undefined
): AutomationHostTarget {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsed.environmentId }
    : { kind: 'local' }
}

export function getAutomationListTarget(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): AutomationHostTarget {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}

export function getAutomationOwnerTarget(
  automation: Pick<Automation, 'runContext'>,
  sourceTarget?: AutomationHostTarget | null
): AutomationHostTarget {
  if (sourceTarget?.kind === 'environment') {
    return sourceTarget
  }
  return getAutomationTargetFromHostId(automation.runContext?.hostId)
}

/** Renames the desktop input's target fields to the wire contract every authority speaks. */
export function toRuntimeAutomationCreateInput(
  input: AutomationCreateInput
): RuntimeAutomationCreateInput {
  const { projectId, workspaceId, ...rest } = input
  return {
    ...rest,
    // Machine selectors must not fall back to path/name matching on a remote host.
    repo: `id:${projectId}`,
    workspace: input.workspaceMode === 'existing' && workspaceId ? `id:${workspaceId}` : undefined
  }
}
/** Renames the desktop input's target fields to the wire contract every authority speaks. */
export function toRuntimeAutomationUpdateInput(
  input: AutomationUpdateInput
): RuntimeAutomationUpdateInput {
  const { projectId, workspaceId, ...rest } = input
  return {
    ...rest,
    ...(projectId !== undefined ? { repo: `id:${projectId}` } : {}),
    ...(workspaceId !== undefined
      ? { workspace: workspaceId ? `id:${workspaceId}` : undefined }
      : {})
  }
}

export async function listAutomationsForTarget(
  target: AutomationHostTarget
): Promise<Automation[]> {
  const result = await callRuntimeRpc<{ automations: Automation[] }>(
    target,
    'automation.list',
    undefined,
    { timeoutMs: 15_000 }
  )
  return result.automations
}

/**
 * One automation's history, never a host's. Usage totals for the list come from
 * the authority's own list projection; fetching every run to compute them made
 * the page's cost scale with retained history rather than with what is on screen.
 */
export async function listAutomationRunsForTarget(
  target: AutomationHostTarget,
  automationId: string
): Promise<AutomationRun[]> {
  const result = await callRuntimeRpc<{ runs: AutomationRun[] }>(
    target,
    'automation.runs',
    { automationId },
    { timeoutMs: 15_000 }
  )
  return result.runs
}

export async function updateAutomationForTarget(
  automation: Automation,
  updates: AutomationUpdateInput,
  sourceTarget?: AutomationHostTarget | null
): Promise<Automation> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
  const result = await callRuntimeRpc<{ automation: Automation }>(
    target,
    'automation.update',
    { id: automation.id, updates: toRuntimeAutomationUpdateInput(updates) },
    { timeoutMs: 15_000 }
  )
  return result.automation
}

export async function deleteAutomationForTarget(
  automation: Automation,
  sourceTarget?: AutomationHostTarget | null
): Promise<void> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
  await callRuntimeRpc(target, 'automation.delete', { id: automation.id }, { timeoutMs: 15_000 })
}

export async function runAutomationNowForTarget(
  automation: Automation,
  sourceTarget?: AutomationHostTarget | null
): Promise<AutomationRun> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
  const result = await callRuntimeRpc<{ run: AutomationRun }>(
    target,
    'automation.runNow',
    { id: automation.id },
    { timeoutMs: 15_000 }
  )
  return result.run
}
