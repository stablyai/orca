// A live agent's report wins; otherwise the chat's saved mode, never a guessed one for own.

import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
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

/** Absent producers retain options fallback; present evidence owns the description, even cleared. */
export function projectRuntimePermission<T extends { reportedPermissionMode?: string | null }>(
  state: T,
  summary: unknown,
  fence: number | null
): T {
  if (typeof summary !== 'object' || summary === null || !('runtimePermission' in summary)) {
    return state
  }
  const report = summary.runtimePermission
  const valid =
    typeof report === 'object' &&
    report !== null &&
    'fence' in report &&
    Number.isSafeInteger(report.fence) &&
    typeof report.fence === 'number' &&
    report.fence >= 0 &&
    report.fence === fence &&
    'mode' in report &&
    (report.mode === null || typeof report.mode === 'string')
  return { ...state, reportedPermissionMode: valid ? report.mode : undefined }
}
