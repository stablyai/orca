import { ORCHESTRATION_CONTRACT_VERSION } from './protocol-version'

export type OrchestrationMigrationReason =
  | 'client_contract_missing'
  | 'client_contract_unsupported'
  | 'runtime_capability_missing'
  | 'command_retired'

export const ORCHESTRATION_SKILL_COMMAND_ARGS = [
  'skills',
  'get',
  'orchestration',
  '--full'
] as const

export const ORCHESTRATION_LEGACY_RUN_ID = 'run_legacy_local'

const ORCHESTRATION_MUTATION_METHODS = new Set([
  'orchestration.runCreate',
  'orchestration.runUse',
  'orchestration.send',
  'orchestration.reply',
  'orchestration.taskCreate',
  'orchestration.taskUpdate',
  'orchestration.dispatch',
  'orchestration.workerStart',
  'orchestration.workerStop',
  'orchestration.workerAbandon',
  'orchestration.workerRelease',
  'orchestration.workerRetain',
  'orchestration.ask',
  'orchestration.gateCreate',
  'orchestration.gateResolve',
  'orchestration.reset',
  'orchestration.federationAttachStart',
  'orchestration.federationAck',
  'orchestration.federationImport',
  'orchestration.federationStop',
  'orchestration.federationRelease'
])

const RETIRED_ORCHESTRATION_METHODS = new Set(['orchestration.run', 'orchestration.runStop'])

export function isRetiredOrchestrationMethod(method: string): boolean {
  return RETIRED_ORCHESTRATION_METHODS.has(method)
}

export function isOrchestrationMutation(method: string, params: unknown): boolean {
  if (isRetiredOrchestrationMethod(method)) {
    return true
  }
  if (method === 'orchestration.check') {
    if (hasStringProperty(params, 'ack')) {
      return true
    }
    return !isExplicitReadOnlyCheck(params)
  }
  if (method === 'orchestration.dispatch') {
    return !hasTrueProperty(params, 'dryRun')
  }
  return ORCHESTRATION_MUTATION_METHODS.has(method)
}

export function isTerminalPromptMutation(method: string, params: unknown): boolean {
  if (method !== 'terminal.send' || !params || typeof params !== 'object') {
    return false
  }
  const value = params as Record<string, unknown>
  const client = value.client as Record<string, unknown> | undefined
  return (
    value.agentPrompt === true &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.enter === true &&
    value.interrupt !== true &&
    client?.type === 'desktop'
  )
}

export function isDurableMutation(method: string, params: unknown): boolean {
  return isOrchestrationMutation(method, params) || isTerminalPromptMutation(method, params)
}

export function orchestrationSkillRecoveryData(): {
  effectsApplied: false
  guide: { topic: 'orchestration'; full: true }
  nextCommandArgs: typeof ORCHESTRATION_SKILL_COMMAND_ARGS
  nextSteps: string[]
} {
  return {
    effectsApplied: false,
    guide: { topic: 'orchestration', full: true },
    nextCommandArgs: ORCHESTRATION_SKILL_COMMAND_ARGS,
    nextSteps: [
      'Using this same Orca CLI executable, run: skills get orchestration --full',
      'Read the returned guide completely and do not retry the previous command unchanged.'
    ]
  }
}

export function orchestrationMigrationData(reason: OrchestrationMigrationReason): ReturnType<
  typeof orchestrationSkillRecoveryData
> & {
  reason: OrchestrationMigrationReason
  requiredContractVersion: number
} {
  return {
    reason,
    requiredContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    ...orchestrationSkillRecoveryData()
  }
}

function isExplicitReadOnlyCheck(params: unknown): boolean {
  return (
    hasTrueProperty(params, 'peek') ||
    hasTrueProperty(params, 'all') ||
    hasFalseProperty(params, 'unread')
  )
}

function hasStringProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[property] === 'string'
  )
}

function hasTrueProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[property] === true
  )
}

function hasFalseProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[property] === false
  )
}
