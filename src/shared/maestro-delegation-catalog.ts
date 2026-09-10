import type { GlobalSettings } from './global-settings-types'
import type {
  MaestroDelegationCatalog,
  MaestroDelegationPlacement,
  MaestroDelegationPermissionMode
} from './maestro-delegation'
import {
  resolveAgentPermissionModeSummary,
  resolveTuiAgentPermissionMode
} from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'
import type { AgentType } from './agent-status-types'
import { getAgentSessionOptionCatalog, type CatalogModel } from './agent-session-option-catalog'
import { MAESTRO_DELEGATION_EFFORTS } from './maestro-delegation'

export type MaestroDelegationRuntimeSettings = Pick<
  GlobalSettings,
  'disabledTuiAgents' | 'agentDefaultArgs' | 'agentDefaultEnv'
>

export type MaestroDelegationCatalogInput = {
  agents: readonly TuiAgent[]
  settings: MaestroDelegationRuntimeSettings
  placements: readonly MaestroDelegationCatalog['placements'][number][]
}

function catalogModelToOption(
  model: CatalogModel
): MaestroDelegationCatalog['agents'][number]['models'][number] {
  const effortOption = model.options.find((option) => option.id === 'effort')
  const efforts =
    effortOption?.kind.type === 'select'
      ? effortOption.kind.choices
          .map((choice) => choice.value)
          .filter((value): value is (typeof MAESTRO_DELEGATION_EFFORTS)[number] =>
            (MAESTRO_DELEGATION_EFFORTS as readonly string[]).includes(value)
          )
      : []
  return { id: model.id, label: model.label, efforts }
}

function agentOptions(args: {
  agents: readonly TuiAgent[]
  disabledAgents: readonly TuiAgent[]
  permissionModes: Partial<Record<TuiAgent, MaestroDelegationPermissionMode>>
}): MaestroDelegationCatalog['agents'] {
  const disabled = new Set(args.disabledAgents)
  return args.agents.map((agent) => {
    const catalog = getAgentSessionOptionCatalog(agent as AgentType)
    return {
      id: agent,
      label: agent,
      enabled: !disabled.has(agent),
      disabled_reason: disabled.has(agent) ? 'Disabled in Orca agent settings.' : null,
      models: catalog?.models.map(catalogModelToOption) ?? [],
      permission_mode: args.permissionModes[agent] ?? 'manual'
    }
  })
}

export function resolveMaestroPermissionMode(
  agent: TuiAgent | null,
  settings: MaestroDelegationRuntimeSettings
): MaestroDelegationPermissionMode {
  if (!agent) {
    return resolveAgentPermissionModeSummary(settings)
  }
  return resolveTuiAgentPermissionMode({
    agent,
    agentArgs: settings.agentDefaultArgs?.[agent],
    agentEnv: settings.agentDefaultEnv?.[agent]
  })
}

export function buildMaestroDelegationCatalog(
  input: MaestroDelegationCatalogInput
): MaestroDelegationCatalog {
  const permissionModes = Object.fromEntries(
    input.agents.map((agent) => [agent, resolveMaestroPermissionMode(agent, input.settings)])
  ) as Partial<Record<TuiAgent, MaestroDelegationPermissionMode>>
  const permissionMode = resolveMaestroPermissionMode(null, input.settings)
  return {
    agents: agentOptions({
      agents: input.agents,
      disabledAgents: input.settings.disabledTuiAgents,
      permissionModes
    }),
    permission_mode: {
      value: permissionMode,
      display_only: true,
      reason: 'Permission mode is owned by Orca settings and cannot be changed by a Canvas request.'
    },
    placements: [...input.placements]
  }
}

export function findMaestroPlacement(
  placements: readonly MaestroDelegationCatalog['placements'][number][],
  requested: MaestroDelegationPlacement
): MaestroDelegationPlacement | undefined {
  return placements.find((entry) => {
    if (!entry.enabled || entry.placement.kind !== requested.kind) {
      return false
    }
    if (requested.kind === 'current-workspace') {
      return true
    }
    if (requested.kind === 'existing-workspace' && entry.placement.kind === 'existing-workspace') {
      return (
        entry.placement.execution_host_id === requested.execution_host_id &&
        entry.placement.workspace_key === requested.workspace_key
      )
    }
    return (
      entry.placement.kind === 'create-child-worktree' &&
      requested.kind === 'create-child-worktree' &&
      entry.placement.execution_host_id === requested.execution_host_id &&
      entry.placement.parent_workspace_key === requested.parent_workspace_key
    )
  })?.placement
}
