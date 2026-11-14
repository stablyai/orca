// Saved choices describe requested policy; runtime observations never replace that intent.

import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  type AgentChatPermissionMode
} from '../../agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModes } from '../../agent-launch/permissions/agent-chat-permission-support'
import type { StructuredAgentSessionOptionRecord } from './structured-agent-session-option-state'
import type { SessionOptionDescriptor } from '../../native-chat/input/native-chat-session-options'

/** English names and descriptions for surfaces without a translation catalog. */
const MODE_COPY: Readonly<Record<AgentChatPermissionMode, { label: string; description: string }>> =
  {
    ask: {
      label: 'Ask for approval',
      description: "Asks before edits and commands your settings don't allow"
    },
    'accept-edits': {
      label: 'Accept edits',
      description: 'Approves file edits and file commands; asks for the rest'
    },
    auto: { label: 'Approve for me', description: 'Reviews approval requests for you' },
    'full-access': {
      label: 'Full access',
      description: 'Never asks before edits or commands'
    }
  }

// Claude's copy names the person's own settings; other agents decide what they already allow.
const OTHER_AGENT_DESCRIPTIONS: Partial<Record<AgentChatPermissionMode, string>> = {
  ask: "Asks before edits or commands it isn't already allowed to make"
}

const CODEX_DESCRIPTIONS: Partial<Record<AgentChatPermissionMode, string>> = {
  ...OTHER_AGENT_DESCRIPTIONS,
  'full-access': 'Never asks; can edit any file and use the network'
}

const ANTIGRAVITY_DESCRIPTIONS: Partial<Record<AgentChatPermissionMode, string>> = {
  ...OTHER_AGENT_DESCRIPTIONS,
  'accept-edits': 'Approves file edits; asks for the rest'
}

const AGENT_DESCRIPTIONS = new Map<string, Partial<Record<AgentChatPermissionMode, string>>>([
  ['codex', CODEX_DESCRIPTIONS],
  ['claude', {}],
  ['antigravity', ANTIGRAVITY_DESCRIPTIONS]
])

function agentDescriptions(agent: string): Partial<Record<AgentChatPermissionMode, string>> {
  return AGENT_DESCRIPTIONS.get(agent) ?? OTHER_AGENT_DESCRIPTIONS
}

export function structuredAgentSessionPermissionDescriptor(state: {
  record: StructuredAgentSessionOptionRecord
  permissionMode: string | null
  permissionOwnSupported?: boolean | null
  launchPermissionMode?: string
  reportedPermissionMode?: string | null
}): SessionOptionDescriptor | null {
  const support = agentChatPermissionModes(state.record.agent)
  const own = state.permissionMode === 'own'
  if (!support || (!own && !support.modes.some((mode) => mode === state.permissionMode))) {
    return null
  }
  const current = state.permissionMode ?? undefined
  const reported = support.modes.find((mode) => mode === current)
  const label = own
    ? "Agent's own settings"
    : reported
      ? MODE_COPY[reported].label
      : current === 'plan'
        ? 'Plan mode'
        : current === 'read-only'
          ? 'Read only'
          : (current ?? 'Permissions')
  // Claude applies a pick on reacquisition; Codex can apply one to its reused child.
  const activeValue =
    state.record.agent === 'claude' &&
    state.launchPermissionMode !== undefined &&
    state.launchPermissionMode !== current
      ? state.launchPermissionMode
      : undefined
  return {
    description: label,
    id: AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
    label: 'Permissions',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: current,
      choices: support.modes.map((value) => ({
        value,
        label: MODE_COPY[value].label,
        description: agentDescriptions(state.record.agent)[value] ?? MODE_COPY[value].description
      }))
    },
    valueSource: activeValue === undefined ? 'applied' : 'dispatched',
    ...(activeValue === undefined ? {} : { activeValue }),
    transport: 'agent-session',
    settable: state.permissionOwnSupported !== null
  }
}

/** Older hosts apply their own Agent Permissions instead of per-chat modes. */
export const LEGACY_HOST_PERMISSION_VALUE = 'host'

/** Read-only legacy-host mode prevents unsupported per-chat settings from looking unset. */
export function legacyHostPermissionDescriptor(): SessionOptionDescriptor {
  return {
    id: AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
    label: 'Permissions',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: LEGACY_HOST_PERMISSION_VALUE,
      choices: [
        {
          value: LEGACY_HOST_PERMISSION_VALUE,
          label: "Host's Agent Permissions",
          description:
            "This host runs an older Orca that applies its Agent Permissions to every chat and can't ask per chat. Update Orca on the host to choose a mode here."
        }
      ]
    },
    valueSource: 'applied',
    transport: 'agent-session',
    settable: false
  }
}

/** No runtime permission evidence: the options fallback stands. */
export const NO_RUNTIME_PERMISSION_REPORT = false

/** A primitive per answer, so subscribers re-render only when it changes: no evidence, cleared or stale (undefined), or the reported mode. */
export function runtimePermissionReport(
  summary: unknown,
  fence: number | null
): typeof NO_RUNTIME_PERMISSION_REPORT | string | null | undefined {
  if (typeof summary !== 'object' || summary === null || !('runtimePermission' in summary)) {
    return NO_RUNTIME_PERMISSION_REPORT
  }
  const report = summary.runtimePermission
  if (
    typeof report !== 'object' ||
    report === null ||
    !('fence' in report) ||
    !Number.isSafeInteger(report.fence) ||
    typeof report.fence !== 'number' ||
    report.fence < 0 ||
    report.fence !== fence ||
    !('mode' in report)
  ) {
    return undefined
  }
  const mode = report.mode
  return mode === null || typeof mode === 'string' ? mode : undefined
}

/** Absent producers retain options fallback; present evidence owns the description, even cleared. */
export function applyRuntimePermissionReport<T extends { reportedPermissionMode?: string | null }>(
  state: T,
  report: ReturnType<typeof runtimePermissionReport>
): T {
  return report === NO_RUNTIME_PERMISSION_REPORT
    ? state
    : { ...state, reportedPermissionMode: report }
}

export function projectRuntimePermission<T extends { reportedPermissionMode?: string | null }>(
  state: T,
  summary: unknown,
  fence: number | null
): T {
  return applyRuntimePermissionReport(state, runtimePermissionReport(summary, fence))
}
