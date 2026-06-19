import type {
  GlobalSettings,
  GlpiConnectArgs,
  GlpiConnectionStatus,
  GlpiCreateTicketArgs,
  GlpiCreateTicketResult,
  GlpiFollowup,
  GlpiMutationResult,
  GlpiServerSelection,
  GlpiTicket,
  GlpiTicketFilter,
  GlpiTicketUpdate,
  GlpiViewer,
  GlpiWorkItemFilters
} from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export type RuntimeGlpiSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

export type GlpiConnectResult = { ok: true; viewer: GlpiViewer } | { ok: false; error: string }

function isTaskSourceRuntimeSettings(settings: RuntimeGlpiSettings): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

function getGlpiRuntimeTarget(
  settings: RuntimeGlpiSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  // Why: task source context makes provider ownership explicit; legacy callers
  // still pass focused runtime settings until Tasks finishes migrating.
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

export async function glpiStatus(settings: RuntimeGlpiSettings): Promise<GlpiConnectionStatus> {
  const target = getGlpiRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiConnectionStatus>(target, 'glpi.status', undefined, { timeoutMs: 15_000 })
    : window.api.glpi.status()
}

export async function glpiConnect(
  settings: RuntimeGlpiSettings,
  args: GlpiConnectArgs
): Promise<GlpiConnectResult> {
  const target = getGlpiRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiConnectResult>(target, 'glpi.connect', args, { timeoutMs: 30_000 })
    : window.api.glpi.connect(args)
}

export async function glpiDisconnect(
  settings: RuntimeGlpiSettings,
  serverId?: string | null
): Promise<void> {
  const target = getGlpiRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(
      target,
      'glpi.disconnect',
      serverId ? { serverId } : undefined,
      { timeoutMs: 15_000 }
    )
    return
  }
  await window.api.glpi.disconnect(serverId ? { serverId } : undefined)
}

export async function glpiSelectServer(
  settings: RuntimeGlpiSettings,
  serverId: GlpiServerSelection
): Promise<GlpiConnectionStatus> {
  const target = getGlpiRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiConnectionStatus>(
        target,
        'glpi.selectServer',
        { serverId },
        { timeoutMs: 15_000 }
      )
    : window.api.glpi.selectServer({ serverId })
}

export async function glpiTestConnection(
  settings: RuntimeGlpiSettings,
  serverId?: string | null
): Promise<GlpiConnectResult> {
  const target = getGlpiRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiConnectResult>(
        target,
        'glpi.testConnection',
        serverId ? { serverId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.glpi.testConnection(serverId ? { serverId } : undefined)
}

export async function glpiListWorkItems(
  settings: RuntimeGlpiSettings,
  serverId: GlpiServerSelection | null | undefined,
  filter: GlpiTicketFilter,
  limit: number,
  filters?: GlpiWorkItemFilters
): Promise<GlpiTicket[]> {
  const target = getGlpiRuntimeTarget(settings)
  const args = { serverId: serverId ?? undefined, filter, limit, filters }
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiTicket[]>(target, 'glpi.listWorkItems', args, { timeoutMs: 30_000 })
    : window.api.glpi.listWorkItems(args)
}

export async function glpiTicket(
  settings: RuntimeGlpiSettings,
  serverId: string | null | undefined,
  id: number
): Promise<GlpiTicket | null> {
  const target = getGlpiRuntimeTarget(settings)
  const args = { serverId: serverId ?? undefined, id }
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiTicket | null>(target, 'glpi.ticket', args, { timeoutMs: 30_000 })
    : window.api.glpi.ticket(args)
}

export async function glpiFollowups(
  settings: RuntimeGlpiSettings,
  serverId: string | null | undefined,
  id: number
): Promise<GlpiFollowup[]> {
  const target = getGlpiRuntimeTarget(settings)
  const args = { serverId: serverId ?? undefined, id }
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiFollowup[]>(target, 'glpi.followups', args, { timeoutMs: 30_000 })
    : window.api.glpi.followups(args)
}

export async function glpiAddFollowup(
  settings: RuntimeGlpiSettings,
  serverId: string | null | undefined,
  id: number,
  content: string
): Promise<GlpiMutationResult> {
  const target = getGlpiRuntimeTarget(settings)
  const args = { serverId: serverId ?? undefined, id, content }
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiMutationResult>(target, 'glpi.addFollowup', args, { timeoutMs: 30_000 })
    : window.api.glpi.addFollowup(args)
}

export async function glpiUpdateTicket(
  settings: RuntimeGlpiSettings,
  serverId: string | null | undefined,
  id: number,
  updates: GlpiTicketUpdate
): Promise<GlpiMutationResult> {
  const target = getGlpiRuntimeTarget(settings)
  const args = { serverId: serverId ?? undefined, id, updates }
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiMutationResult>(target, 'glpi.updateTicket', args, { timeoutMs: 30_000 })
    : window.api.glpi.updateTicket(args)
}

export async function glpiCreateTicket(
  settings: RuntimeGlpiSettings,
  args: GlpiCreateTicketArgs
): Promise<GlpiCreateTicketResult> {
  const target = getGlpiRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<GlpiCreateTicketResult>(target, 'glpi.createTicket', args, {
        timeoutMs: 30_000
      })
    : window.api.glpi.createTicket(args)
}
