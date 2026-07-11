import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput,
  ExternalAutomationActionInput,
  ExternalAutomationCreateInput,
  ExternalAutomationManager,
  ExternalAutomationRunsInput,
  ExternalAutomationRunsPage,
  ExternalAutomationUpdateInput
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

export type AutomationHostTarget =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string }

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

export function getAutomationCreateTarget(input: AutomationCreateInput): AutomationHostTarget {
  return getAutomationTargetFromHostId(input.runContext?.hostId)
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

function asRuntimeExternalManager(
  manager: ExternalAutomationManager,
  environmentId: string
): ExternalAutomationManager {
  const managerId = manager.id.replace(/:local$/, `:runtime:${environmentId}`)
  return {
    ...manager,
    id: managerId,
    label: manager.label.replace('this computer', 'remote Orca runtime'),
    targetLabel: 'remote Orca runtime',
    target: { type: 'runtime', environmentId },
    jobs: manager.jobs.map((job) => ({ ...job, managerId }))
  }
}

export async function listExternalAutomationManagersForTarget(
  target: AutomationHostTarget
): Promise<ExternalAutomationManager[]> {
  if (target.kind === 'local') {
    return await window.api.automations.listExternalManagers()
  }
  const result = await callRuntimeRpc<{ managers: ExternalAutomationManager[] }>(
    target,
    'automation.externalManagers',
    undefined,
    { timeoutMs: 15_000 }
  )
  return result.managers.map((manager) => asRuntimeExternalManager(manager, target.environmentId))
}

function runtimeTargetForExternalAutomation(
  target: ExternalAutomationRunsInput['target']
): AutomationHostTarget | null {
  return target.type === 'runtime'
    ? { kind: 'environment', environmentId: target.environmentId }
    : null
}

export async function listExternalAutomationRunsForTarget(
  input: ExternalAutomationRunsInput
): Promise<ExternalAutomationRunsPage> {
  const target = runtimeTargetForExternalAutomation(input.target)
  if (!target || input.target.type !== 'runtime') {
    return await window.api.automations.listExternalRuns(input)
  }
  const { target: _target, ...params } = input
  const result = await callRuntimeRpc<{ page: ExternalAutomationRunsPage }>(
    target,
    'automation.externalRuns',
    params,
    { timeoutMs: 15_000 }
  )
  return {
    ...result.page,
    managerId: input.managerId,
    target: input.target,
    runs: result.page.runs.map((run) => ({ ...run, managerId: input.managerId }))
  }
}

export async function createExternalAutomationForTarget(
  input: ExternalAutomationCreateInput
): Promise<void> {
  const target = runtimeTargetForExternalAutomation(input.target)
  if (!target) {
    await window.api.automations.createExternal(input)
    return
  }
  const { target: _target, ...params } = input
  await callRuntimeRpc(target, 'automation.externalCreate', params, { timeoutMs: 30_000 })
}

export async function updateExternalAutomationForTarget(
  input: ExternalAutomationUpdateInput
): Promise<void> {
  const target = runtimeTargetForExternalAutomation(input.target)
  if (!target) {
    await window.api.automations.updateExternal(input)
    return
  }
  const { target: _target, ...params } = input
  await callRuntimeRpc(target, 'automation.externalUpdate', params, { timeoutMs: 30_000 })
}

export async function runExternalAutomationActionForTarget(
  input: ExternalAutomationActionInput
): Promise<void> {
  const target = runtimeTargetForExternalAutomation(input.target)
  if (!target) {
    await window.api.automations.runExternalAction(input)
    return
  }
  const { target: _target, ...params } = input
  await callRuntimeRpc(target, 'automation.externalAction', params, { timeoutMs: 30_000 })
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
  updates: AutomationUpdateInput,
  sourceTarget?: AutomationHostTarget | null
): Promise<Automation> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
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

export async function deleteAutomationForTarget(
  automation: Automation,
  sourceTarget?: AutomationHostTarget | null
): Promise<void> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
  if (target.kind === 'local') {
    await window.api.automations.delete({ id: automation.id })
    return
  }
  await callRuntimeRpc(target, 'automation.delete', { id: automation.id }, { timeoutMs: 15_000 })
}

export async function runAutomationNowForTarget(
  automation: Automation,
  sourceTarget?: AutomationHostTarget | null
): Promise<AutomationRun> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
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
