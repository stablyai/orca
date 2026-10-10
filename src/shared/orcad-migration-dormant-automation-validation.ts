import { assertAutomationExtraAgentArgs } from './automation-extra-agent-args-record'
import { isTuiAgent } from './tui-agent-config'
import type { Automation, AutomationRun } from './automations-types'
import { getAutomationRunRepoId } from './automation-run-identity'
import {
  assertUnique,
  boundedArray,
  optionalFinite,
  optionalNullableString,
  optionalPositiveInteger,
  requiredBoolean,
  requiredFinite,
  requiredRecord,
  requiredString,
  requiredStringOrEmpty
} from './orcad-migration-dormant-value-validation'
import {
  parseOutputSnapshot,
  parsePrecheck,
  parsePrecheckResult,
  parseUsage
} from './orcad-migration-dormant-automation-fields'

const FINAL_RUN_STATUSES = new Set<unknown>([
  'completed',
  'dispatch_failed',
  'skipped_precheck',
  'skipped_missed',
  'skipped_unavailable',
  'skipped_needs_interactive_auth'
])

export function parseOrcadMigrationDormantAutomations(value: unknown): Automation[] {
  const automations = boundedArray(value, parseAutomation, 'automations')
  assertUnique(automations, (entry) => entry.id, 'automation')
  return automations
}

export function parseOrcadMigrationDormantAutomationRuns(value: unknown): AutomationRun[] {
  const runs = boundedArray(value, parseAutomationRun, 'automation_runs')
  assertUnique(runs, (entry) => entry.id, 'automation_run')
  return runs
}

export function assertOrcadMigrationDormantAutomationReferences(args: {
  automations: readonly Automation[]
  automationRuns: readonly AutomationRun[]
  repositoryIds: ReadonlySet<string>
  owns: (value: string) => boolean
}): void {
  const automationIds = new Set(args.automations.map((entry) => entry.id))
  for (const automation of args.automations) {
    const repoId = getAutomationRunRepoId(automation)
    if (
      !args.repositoryIds.has(repoId) ||
      !contextBelongsToDestination(automation.runContext, args.repositoryIds) ||
      !contextBelongsToDestination(automation.sourceContext, args.repositoryIds) ||
      (automation.workspaceId !== null && !args.owns(automation.workspaceId))
    ) {
      throw new Error('orcad_migration_dormant_automation_scope_invalid')
    }
  }
  for (const run of args.automationRuns) {
    if (
      !automationIds.has(run.automationId) ||
      !contextBelongsToDestination(run.runContext, args.repositoryIds) ||
      !contextBelongsToDestination(run.sourceContext, args.repositoryIds) ||
      (run.workspaceId !== null && !args.owns(run.workspaceId))
    ) {
      throw new Error('orcad_migration_dormant_automation_run_scope_invalid')
    }
  }
}

function parseAutomation(value: unknown): Automation {
  const copy = structuredClone(value)
  if (!isMigratedAutomation(copy)) {
    throw new Error('orcad_migration_dormant_automation_invalid')
  }
  // A disallowed flag or Reuse with extras would otherwise persist and fail every later run.
  try {
    assertAutomationExtraAgentArgs(copy)
  } catch {
    throw new Error('orcad_migration_dormant_automation_extra_agent_args_invalid')
  }
  return copy
}

/** Throws the specific field error; narrowing only follows these checks. */
function isMigratedAutomation(value: unknown): value is Automation {
  const record = requiredRecord(value, 'orcad_migration_dormant_automation_invalid')
  requiredString(record.id, 'orcad_migration_dormant_automation_id_invalid')
  requiredString(record.name, 'orcad_migration_dormant_automation_name_invalid')
  requiredStringOrEmpty(record.prompt, 'orcad_migration_dormant_automation_prompt_invalid')
  parsePrecheck(record.precheck)
  if (!isTuiAgent(record.agentId)) {
    throw new Error('orcad_migration_dormant_automation_agent_invalid')
  }
  if (record.extraAgentArgs !== undefined && typeof record.extraAgentArgs !== 'string') {
    throw new Error('orcad_migration_dormant_automation_extra_agent_args_invalid')
  }
  parseContext(record.runContext, 'workspace-run')
  parseContext(record.sourceContext, 'task-source')
  requiredString(record.projectId, 'orcad_migration_dormant_automation_project_invalid')
  if (
    record.executionTargetType !== 'local' ||
    record.executionTargetId !== 'local' ||
    record.executionTargetGeneration !== undefined ||
    record.schedulerOwner !== 'remote_host_service' ||
    record.enabled !== false
  ) {
    throw new Error('orcad_migration_dormant_automation_owner_invalid')
  }
  if (!['existing', 'new_per_run'].includes(String(record.workspaceMode))) {
    throw new Error('orcad_migration_dormant_automation_workspace_mode_invalid')
  }
  optionalNullableString(record.workspaceId, 'orcad_migration_dormant_automation_workspace_invalid')
  optionalNullableString(record.baseBranch, 'orcad_migration_dormant_automation_branch_invalid')
  if (
    record.setupDecision !== undefined &&
    record.setupDecision !== 'run' &&
    record.setupDecision !== 'skip'
  ) {
    throw new Error('orcad_migration_dormant_automation_setup_decision_invalid')
  }
  requiredBoolean(record.reuseSession, 'orcad_migration_dormant_automation_reuse_invalid')
  requiredString(record.timezone, 'orcad_migration_dormant_automation_timezone_invalid')
  requiredString(record.rrule, 'orcad_migration_dormant_automation_rrule_invalid')
  for (const field of [
    'dtstart',
    'nextRunAt',
    'missedRunGraceMinutes',
    'createdAt',
    'updatedAt'
  ] as const) {
    requiredFinite(record[field], `orcad_migration_dormant_automation_${field}_invalid`)
  }
  optionalFinite(record.lastRunAt, 'orcad_migration_dormant_automation_last_run_invalid')
  if (record.missedRunPolicy !== 'run_once_within_grace') {
    throw new Error('orcad_migration_dormant_automation_missed_policy_invalid')
  }
  return true
}

function parseAutomationRun(value: unknown): AutomationRun {
  const copy = structuredClone(value)
  if (!isMigratedAutomationRun(copy)) {
    throw new Error('orcad_migration_dormant_automation_run_invalid')
  }
  return copy
}

/** Throws the specific field error; narrowing only follows these checks. */
function isMigratedAutomationRun(value: unknown): value is AutomationRun {
  const record = requiredRecord(value, 'orcad_migration_dormant_automation_run_invalid')
  requiredString(record.id, 'orcad_migration_dormant_automation_run_id_invalid')
  requiredString(record.automationId, 'orcad_migration_dormant_automation_run_owner_invalid')
  parseContext(record.runContext, 'workspace-run')
  parseContext(record.sourceContext, 'task-source')
  requiredString(record.title, 'orcad_migration_dormant_automation_run_title_invalid')
  requiredFinite(record.scheduledFor, 'orcad_migration_dormant_automation_run_schedule_invalid')
  if (!FINAL_RUN_STATUSES.has(record.status)) {
    throw new Error('orcad_migration_dormant_automation_run_status_invalid')
  }
  if (record.trigger !== 'scheduled' && record.trigger !== 'manual') {
    throw new Error('orcad_migration_dormant_automation_run_trigger_invalid')
  }
  optionalNullableString(
    record.workspaceId,
    'orcad_migration_dormant_automation_run_workspace_invalid'
  )
  optionalNullableString(
    record.workspaceDisplayName,
    'orcad_migration_dormant_automation_run_workspace_name_invalid'
  )
  if (record.sessionKind !== 'terminal') {
    throw new Error('orcad_migration_dormant_automation_run_session_invalid')
  }
  for (const field of [
    'chatSessionId',
    'terminalSessionId',
    'terminalPaneKey',
    'terminalPtyId',
    'error'
  ] as const) {
    optionalNullableString(record[field], `orcad_migration_dormant_automation_run_${field}_invalid`)
  }
  parseOutputSnapshot(record.outputSnapshot)
  parsePrecheckResult(record.precheckResult)
  parseUsage(record.usage)
  optionalFinite(record.startedAt, 'orcad_migration_dormant_automation_run_started_invalid', true)
  optionalFinite(
    record.dispatchedAt,
    'orcad_migration_dormant_automation_run_dispatched_invalid',
    true
  )
  requiredFinite(record.createdAt, 'orcad_migration_dormant_automation_run_created_invalid')
  optionalPositiveInteger(record.runNumber, 'orcad_migration_dormant_automation_run_number_invalid')
  optionalPositiveInteger(
    record.occurrenceCount,
    'orcad_migration_dormant_automation_occurrence_count_invalid'
  )
  optionalFinite(
    record.lastOccurrenceAt,
    'orcad_migration_dormant_automation_last_occurrence_invalid'
  )
  return true
}

function parseContext(value: unknown, kind: 'workspace-run' | 'task-source'): void {
  if (value === undefined || value === null) {
    return
  }
  const record = requiredRecord(value, 'orcad_migration_dormant_automation_context_invalid')
  if (record.kind !== kind || record.hostId !== 'local') {
    throw new Error('orcad_migration_dormant_automation_context_owner_invalid')
  }
  requiredString(record.projectId, 'orcad_migration_dormant_automation_context_project_invalid')
  optionalNullableString(
    record.projectHostSetupId,
    'orcad_migration_dormant_automation_context_setup_invalid'
  )
  optionalNullableString(record.repoId, 'orcad_migration_dormant_automation_context_repo_invalid')
  if (kind === 'workspace-run') {
    requiredString(
      record.projectHostSetupId,
      'orcad_migration_dormant_automation_context_setup_invalid'
    )
    requiredString(record.repoId, 'orcad_migration_dormant_automation_context_repo_invalid')
    requiredString(record.path, 'orcad_migration_dormant_automation_context_path_invalid')
  } else if (!['github', 'gitlab', 'linear', 'jira'].includes(String(record.provider))) {
    throw new Error('orcad_migration_dormant_automation_context_provider_invalid')
  }
}

function contextBelongsToDestination(
  context: Automation['runContext'] | Automation['sourceContext'],
  repositoryIds: ReadonlySet<string>
): boolean {
  if (!context) {
    return true
  }
  if (context.hostId !== 'local') {
    return false
  }
  if (context.repoId && !repositoryIds.has(context.repoId)) {
    return false
  }
  return !context.projectHostSetupId || context.projectHostSetupId === context.repoId
}
