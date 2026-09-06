import { getHostContextLabel, type HostContextLabelSources } from '../worktree/host-context-labels'
import { parseExecutionHostId, type ExecutionHostKind } from '../execution-host'
import {
  PLUGIN_AGENT_MODEL_MAX_LENGTH,
  PLUGIN_AGENT_PROFILE_MAX_LENGTH,
  PLUGIN_AGENT_TYPE_MAX_LENGTH,
  PLUGIN_WORKSPACE_LABEL_MAX_LENGTH
} from './plugin-host-api'

export {
  PLUGIN_AGENT_MODEL_MAX_LENGTH,
  PLUGIN_AGENT_PROFILE_MAX_LENGTH,
  PLUGIN_AGENT_TYPE_MAX_LENGTH
}

export type PluginWorkspaceExecutionHost = {
  kind: ExecutionHostKind
  label: string
}

export type PluginWorkspaceAgentContext = {
  type: string | null
  model: string | null
  profile: string | null
}

export type PluginAgentStatusSnapshot = {
  worktreeId?: string | null
  state?: string
  agentType?: string | null
  model?: string | null
  receivedAt?: number
}

function clampLabel(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.slice(0, max)
}

/** User-facing execution-host kind + label. Never hostname, path, or host id. */
export function projectPluginExecutionHost(
  hostId: string | null | undefined,
  sources: HostContextLabelSources = {}
): PluginWorkspaceExecutionHost | null {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    return null
  }
  const label = clampLabel(
    getHostContextLabel(parsed.id, sources),
    PLUGIN_WORKSPACE_LABEL_MAX_LENGTH
  )
  if (!label) {
    return null
  }
  return { kind: parsed.kind, label }
}

/** Bounded agent labels. Returns null when nothing known is left to publish. */
export function projectPluginAgentContext(input: {
  type?: string | null
  model?: string | null
  profile?: string | null
}): PluginWorkspaceAgentContext | null {
  const type = clampLabel(input.type, PLUGIN_AGENT_TYPE_MAX_LENGTH)
  const model = clampLabel(input.model, PLUGIN_AGENT_MODEL_MAX_LENGTH)
  const profile = clampLabel(input.profile, PLUGIN_AGENT_PROFILE_MAX_LENGTH)
  if (!type && !model && !profile) {
    return null
  }
  return { type, model, profile }
}

/** Newest non-done row on this worktree wins; otherwise newest labeled row; else fallback type. */
export function selectPluginAgentLabels(
  statuses: readonly PluginAgentStatusSnapshot[],
  worktreeId: string,
  fallbackType?: string | null
): { type: string | null; model: string | null } {
  const matches = statuses.filter((status) => status.worktreeId === worktreeId)
  const ranked = [...matches].sort(
    (left, right) => (right.receivedAt ?? 0) - (left.receivedAt ?? 0)
  )
  const preferred =
    ranked.find((status) => status.state !== 'done' && (status.agentType || status.model)) ??
    ranked.find((status) => status.agentType || status.model)
  return {
    type:
      clampLabel(preferred?.agentType, PLUGIN_AGENT_TYPE_MAX_LENGTH) ??
      clampLabel(fallbackType, PLUGIN_AGENT_TYPE_MAX_LENGTH),
    model: clampLabel(preferred?.model, PLUGIN_AGENT_MODEL_MAX_LENGTH)
  }
}
