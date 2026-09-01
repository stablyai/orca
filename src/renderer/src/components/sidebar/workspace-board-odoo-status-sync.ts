import {
  odooGetTicket,
  odooListStages,
  odooUpdateTicket,
  type RuntimeOdooSettings
} from '@/runtime/runtime-odoo-client'
import type { OdooStage, OdooTicket } from '../../../../shared/odoo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
export type OdooBoardStatusSyncResult = {
  updated: number
  skipped: number
  failed: number
  messages: OdooBoardStatusSyncMessage[]
}

export type OdooBoardStatusSyncMessage =
  | { kind: 'ticket-read-failed'; ticketRef: string }
  | { kind: 'unmapped-status'; statusLabel: string }
  | { kind: 'missing-stage'; statusLabel: string; stageName: string }
  | { kind: 'ambiguous-stage'; statusLabel: string; stageName: string }
  | { kind: 'update-failed'; ticketRef: string; detail?: string }
  | { kind: 'provider-error'; ticketRef: string; detail?: string }

export type OdooBoardStatusSyncDependencies = {
  getTicket: typeof odooGetTicket
  listStages: typeof odooListStages
  updateTicket: typeof odooUpdateTicket
}

/** Case- and accent-insensitive: "En cours" must match "en cours". */
export function normalizeOdooStageName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/**
 * Stages carrying the configured name. Returned as a list so the caller can
 * tell "no such stage" from "several stages share this name" — Odoo allows
 * duplicate `project.task.type` names, and guessing between them would move
 * tickets to an arbitrary column.
 */
export function matchingOdooStages(stages: readonly OdooStage[], stageName: string): OdooStage[] {
  const target = normalizeOdooStageName(stageName)
  if (!target) {
    return []
  }
  return stages.filter((stage) => normalizeOdooStageName(stage.name) === target)
}

/** The Odoo stage a board column maps to, or null when the column is unmapped. */
export function getMappedOdooStageName(status: WorkspaceStatusDefinition): string | null {
  const name = status.odooStageName?.trim()
  return name ? name : null
}

export function emptyOdooBoardStatusSyncResult(): OdooBoardStatusSyncResult {
  return { updated: 0, skipped: 0, failed: 0, messages: [] }
}

function addMessage(result: OdooBoardStatusSyncResult, message: OdooBoardStatusSyncMessage): void {
  const key = JSON.stringify(message)
  if (!result.messages.some((item) => JSON.stringify(item) === key)) {
    result.messages.push(message)
  }
}

export type SyncOdooBoardStatusArgs = {
  worktreeIds: readonly string[]
  targetStatus: WorkspaceStatusDefinition
  worktreesById: ReadonlyMap<string, Pick<Worktree, 'linkedOdooTicket' | 'linkedOdooInstanceId'>>
  getSettingsForWorktree: (worktreeId: string) => RuntimeOdooSettings
  /** Board moves are local-first; a slow read must not overwrite a newer move. */
  getLatestWorkspaceStatus: (worktreeId: string) => string | null | undefined
  deps?: Partial<OdooBoardStatusSyncDependencies>
}

const defaultDeps: OdooBoardStatusSyncDependencies = {
  getTicket: odooGetTicket,
  listStages: odooListStages,
  updateTicket: odooUpdateTicket
}

async function syncOneWorktree(
  args: SyncOdooBoardStatusArgs,
  worktreeId: string,
  deps: OdooBoardStatusSyncDependencies
): Promise<OdooBoardStatusSyncResult> {
  const result = emptyOdooBoardStatusSyncResult()
  const worktree = args.worktreesById.get(worktreeId)
  const ticketId = worktree?.linkedOdooTicket
  if (!ticketId) {
    result.skipped += 1
    return result
  }

  const stageName = getMappedOdooStageName(args.targetStatus)
  if (!stageName) {
    result.skipped += 1
    addMessage(result, { kind: 'unmapped-status', statusLabel: args.targetStatus.label })
    return result
  }

  const settings = args.getSettingsForWorktree(worktreeId)
  const instanceId = worktree?.linkedOdooInstanceId ?? null
  const ticketRef = `#${ticketId}`

  try {
    const ticket: OdooTicket | null = await deps.getTicket(settings, ticketId, instanceId)
    // Private todos carry no project, so they have no stage list to match against.
    if (!ticket?.project?.id) {
      result.skipped += 1
      addMessage(result, { kind: 'ticket-read-failed', ticketRef })
      return result
    }

    const stages = await deps.listStages(settings, ticket.project.id, instanceId)
    const matches = matchingOdooStages(stages, stageName)
    if (matches.length === 0) {
      result.skipped += 1
      addMessage(result, {
        kind: 'missing-stage',
        statusLabel: args.targetStatus.label,
        stageName
      })
      return result
    }
    if (matches.length > 1) {
      result.skipped += 1
      addMessage(result, {
        kind: 'ambiguous-stage',
        statusLabel: args.targetStatus.label,
        stageName
      })
      return result
    }

    const [stage] = matches
    if (ticket.stage?.id === stage.id) {
      result.skipped += 1
      return result
    }
    if (args.getLatestWorkspaceStatus(worktreeId) !== args.targetStatus.id) {
      result.skipped += 1
      return result
    }

    const updateResult = await deps.updateTicket(
      settings,
      ticketId,
      { stageId: stage.id },
      instanceId ?? undefined
    )
    if (updateResult.ok === false) {
      result.failed += 1
      addMessage(result, { kind: 'update-failed', ticketRef, detail: updateResult.error })
      return result
    }
    result.updated += 1
    return result
  } catch (error) {
    result.failed += 1
    addMessage(result, {
      kind: 'provider-error',
      ticketRef,
      detail: error instanceof Error ? error.message : undefined
    })
    return result
  }
}

export async function syncOdooBoardStatuses(
  args: SyncOdooBoardStatusArgs
): Promise<OdooBoardStatusSyncResult> {
  const deps = { ...defaultDeps, ...args.deps }
  const aggregate = emptyOdooBoardStatusSyncResult()
  const results = await Promise.all(
    [...new Set(args.worktreeIds)].map((worktreeId) => syncOneWorktree(args, worktreeId, deps))
  )
  for (const item of results) {
    aggregate.updated += item.updated
    aggregate.skipped += item.skipped
    aggregate.failed += item.failed
    for (const message of item.messages) {
      addMessage(aggregate, message)
    }
  }
  return aggregate
}
