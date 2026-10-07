import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import type { AgentPermissionPosture } from '../../../../shared/tui-agent-permission-args'

/** The part of an agent's row that sets its mode, and where the Agent Permissions line links to. */
export type AgentPermissionRevealTarget = 'permissions' | 'arguments' | 'environment'

export type AgentPermissionExceptionReason =
  | { kind: 'own-setting' }
  | { kind: 'arguments'; options: string[] }
  | { kind: 'environment'; options: string[] }

/** An agent the Agent Permissions switch won't move, with why. */
export type AgentPermissionException = {
  agentId: TuiAgent
  label: string
  effectiveBypass: boolean
  reason: AgentPermissionExceptionReason
  /** Where its row edits that reason; null while detection hasn't finished and no rows render. */
  target: AgentPermissionRevealTarget | null
}

/**
 * Every agent with its own choice, installed or not (it may run on an SSH host), plus installed
 * agents whose Arguments or env launch them differently. Arguments and env decide the launch, so
 * they are the reason whenever they set permissions.
 */
export function buildAgentPermissionExceptions(args: {
  catalog: readonly { id: TuiAgent; label: string }[]
  postures: ReadonlyMap<TuiAgent, AgentPermissionPosture>
  overrides: Partial<Record<TuiAgent, unknown>>
  defaultMode: AgentPermissionMode
  detectedIds: ReadonlySet<string> | null
}): AgentPermissionException[] {
  return args.catalog.flatMap((agent) => {
    const posture = args.postures.get(agent.id)
    const detected = args.detectedIds?.has(agent.id) === true
    const ownSetting = args.overrides[agent.id] !== undefined
    const differs = posture?.effectiveBypass !== (args.defaultMode === 'bypass')
    if (!posture || !(ownSetting || (detected && differs))) {
      return []
    }
    const reason: AgentPermissionExceptionReason =
      posture.typedArgumentOptions.length > 0
        ? { kind: 'arguments', options: posture.typedArgumentOptions }
        : posture.typedEnvironmentOptions.length > 0
          ? { kind: 'environment', options: posture.typedEnvironmentOptions }
          : { kind: 'own-setting' }
    const target: AgentPermissionRevealTarget | null =
      args.detectedIds === null ? null : reason.kind === 'own-setting' ? 'permissions' : reason.kind
    return [
      {
        agentId: agent.id,
        label: agent.label,
        effectiveBypass: posture.effectiveBypass,
        reason,
        target
      }
    ]
  })
}
