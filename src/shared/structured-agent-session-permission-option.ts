// A live agent's report wins; otherwise the chat's saved mode, never a guessed one for own.

import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from './agent-chat-permission-mode'
import type { StructuredAgentSessionOptionRecord } from './structured-agent-session-option-state'
import type { SessionOptionDescriptor } from './native-chat/input/native-chat-session-options'

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
  reportedPermissionMode?: string | null
}): SessionOptionDescriptor | null {
  const support = agentChatPermissionModes(state.record.agent)
  const own = state.permissionMode === 'own'
  if (!support || (!own && !support.modes.some((mode) => mode === state.permissionMode))) {
    return null
  }
  // Without a report an explicit chat shows the saved mode its next turn applies; own has none.
  const current =
    state.reportedPermissionMode !== undefined
      ? (state.reportedPermissionMode ?? undefined)
      : own
        ? undefined
        : (state.permissionMode ?? undefined)
  const reported = support.modes.find((mode) => mode === current)
  const label = reported
    ? MODE_COPY[reported].label
    : current === 'plan'
      ? 'Plan mode'
      : current === 'read-only'
        ? 'Read only'
        : (current ?? 'Permissions')
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
    valueSource:
      current === undefined
        ? 'unknown'
        : state.reportedPermissionMode === undefined
          ? 'applied'
          : 'reported',
    transport: 'agent-session',
    settable: state.permissionOwnSupported !== null && current !== undefined
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

/** The running agent's mode report for this fence: undefined from a host that sends none. */
export function readRuntimePermissionReport(
  summary: unknown,
  fence: number | null
): { mode: string | null } | null | undefined {
  if (typeof summary !== 'object' || summary === null || !('runtimePermission' in summary)) {
    return undefined
  }
  const report = summary.runtimePermission
  if (
    typeof report !== 'object' ||
    report === null ||
    !('fence' in report) ||
    typeof report.fence !== 'number' ||
    !Number.isSafeInteger(report.fence) ||
    report.fence < 0 ||
    report.fence !== fence ||
    !('mode' in report) ||
    (report.mode !== null && typeof report.mode !== 'string')
  ) {
    return null
  }
  return { mode: report.mode }
}

/** Names the agent's current report, so a pick made over it gives way to the next one. */
export function runtimePermissionReportKey(summary: unknown, fence: number | null): string | null {
  const report = readRuntimePermissionReport(summary, fence)
  return report ? `${fence}:${report.mode}` : null
}

/** Absent producers retain options fallback; present evidence owns the description, even cleared.
 *  A pick the agent hasn't taken yet stands in for its report until the agent answers it. */
export function projectRuntimePermission<
  T extends { reportedPermissionMode?: string | null; permissionMode?: string | null }
>(state: T, summary: unknown, fence: number | null, pickStands = false): T {
  const report = readRuntimePermissionReport(summary, fence)
  if (report === undefined) {
    return state
  }
  if (pickStands && isAgentChatPermissionMode(state.permissionMode)) {
    return { ...state, reportedPermissionMode: state.permissionMode }
  }
  return { ...state, reportedPermissionMode: report ? report.mode : undefined }
}
