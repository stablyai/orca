import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/types'

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

type AutomationHostTarget = { kind: 'local' } | { kind: 'environment'; environmentId: string }

function getRuntimeTargetFromHostId(hostId: string | null | undefined): AutomationHostTarget {
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
  automation: Pick<Automation, 'runContext'>
): AutomationHostTarget {
  return getRuntimeTargetFromHostId(automation.runContext?.hostId)
}

export function getAutomationCreateTarget(input: AutomationCreateInput): AutomationHostTarget {
  return getRuntimeTargetFromHostId(input.runContext?.hostId)
}

function toRuntimeAutomationCreateInput(
  input: AutomationCreateInput
): RuntimeAutomationCreateInput {
  const { projectId, workspaceId, ...rest } = input
  return {
    ...rest,
    repo: projectId,
    workspace: input.workspaceMode === 'existing' ? (workspaceId ?? undefined) : undefined
  }
}

function toRuntimeAutomationUpdateInput(
  input: AutomationUpdateInput
): RuntimeAutomationUpdateInput {
  const { projectId, workspaceId, ...rest } = input
  return {
    ...rest,
    ...(projectId !== undefined ? { repo: projectId } : {}),
    ...(workspaceId !== undefined ? { workspace: workspaceId ?? undefined } : {})
  }
}

export async function listAutomationsForTarget(
  target: AutomationHostTarget
): Promise<Automation[]> {
  if (target.kind === 'local') {
    return await window.api.automations.list()
  }
  const result = await callRuntimeRpc<{ automations: Automation[] }>(
    target,
    'automation.list',
    undefined,
    { timeoutMs: 15_000 }
  )
  return result.automations
}

export async function listAutomationRunsForTarget(
  target: AutomationHostTarget,
  automationId?: string
): Promise<AutomationRun[]> {
  if (target.kind === 'local') {
    return await window.api.automations.listRuns(automationId ? { automationId } : undefined)
  }
  const result = await callRuntimeRpc<{ runs: AutomationRun[] }>(
    target,
    'automation.runs',
    automationId ? { automationId } : {},
    { timeoutMs: 15_000 }
  )
  return result.runs
}

export async function createAutomationForTarget(input: AutomationCreateInput): Promise<Automation> {
  const target = getAutomationCreateTarget(input)
  if (target.kind === 'local') {
    return await window.api.automations.create(input)
  }
  const result = await callRuntimeRpc<{ automation: Automation }>(
    target,
    'automation.create',
    toRuntimeAutomationCreateInput(input),
    { timeoutMs: 15_000 }
  )
  return result.automation
}

export async function updateAutomationForTarget(
  automation: Automation,
  updates: AutomationUpdateInput
): Promise<Automation> {
  const target = getAutomationOwnerTarget(automation)
  if (target.kind === 'local') {
    return await window.api.automations.update({ id: automation.id, updates })
  }
  const result = await callRuntimeRpc<{ automation: Automation }>(
    target,
    'automation.update',
    { id: automation.id, updates: toRuntimeAutomationUpdateInput(updates) },
    { timeoutMs: 15_000 }
  )
  return result.automation
}

export async function deleteAutomationForTarget(automation: Automation): Promise<void> {
  const target = getAutomationOwnerTarget(automation)
  if (target.kind === 'local') {
    await window.api.automations.delete({ id: automation.id })
    return
  }
  await callRuntimeRpc(target, 'automation.delete', { id: automation.id }, { timeoutMs: 15_000 })
}

export async function runAutomationNowForTarget(automation: Automation): Promise<AutomationRun> {
  const target = getAutomationOwnerTarget(automation)
  if (target.kind === 'local') {
    return await window.api.automations.runNow({ id: automation.id })
  }
  const result = await callRuntimeRpc<{ run: AutomationRun }>(
    target,
    'automation.runNow',
    { id: automation.id },
    { timeoutMs: 15_000 }
  )
  return result.run
}
