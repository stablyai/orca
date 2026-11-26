// Saved choices describe requested policy; runtime observations never replace that intent.
import type { AgentChatPermissionMode } from '../../../agent-launch/permissions/agent-chat-permission-mode'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../agent-launch/permissions/agent-chat-permission-mode-option-id'
import { agentChatPermissionModes } from '../../../agent-launch/permissions/agent-chat-permission-support'
import { agentPermissionSettingsSourceName } from '../../../agent-launch/permissions/agent-permission-settings-source'
import type { StructuredAgentSessionOptionRecord } from '../reconciliation/structured-agent-session-option-state'
import type { SessionOptionDescriptor } from '../../../native-chat/input/native-chat-session-options'

/** English names and descriptions for surfaces without a translation catalog. */
const MODE_COPY: Readonly<Record<AgentChatPermissionMode, { label: string; description: string }>> =
  {
    'read-only': {
      label: 'Read-only',
      description: 'Uses the agent’s read-only sandbox without approval escalation'
    },
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

/** A mode's name and what it does on `agent`, for surfaces that list the modes themselves. */
export function agentChatPermissionModeCopy(
  agent: string,
  mode: AgentChatPermissionMode
): { label: string; description: string } {
  return {
    label: MODE_COPY[mode].label,
    description: agentDescriptions(agent)[mode] ?? MODE_COPY[mode].description
  }
}

export function structuredAgentSessionPermissionDescriptor(state: {
  record: StructuredAgentSessionOptionRecord
  permissionMode: string | null
  permissionOwnSupported?: boolean | null
  launchPermissionMode?: string
  runningPermissionMode?: string
  reportedPermissionMode?: string | null
}): SessionOptionDescriptor | null {
  const support = agentChatPermissionModes(state.record.agent)
  const own = state.permissionMode === 'own'
  if (!support || (!own && !support.modes.some((mode) => mode === state.permissionMode))) {
    return null
  }
  const current = state.permissionMode ?? undefined
  // Own delegates to the agent, so show the mode it reports running in; the saved choice stays Own.
  // null reads as no report: it can't tell a policy Orca has no name for from no mode at all.
  const reportedValue = own ? (state.reportedPermissionMode ?? undefined) : undefined
  const shown = reportedValue ?? current
  const known = support.modes.find((mode) => mode === shown)
  const label =
    own && reportedValue === undefined
      ? `${agentPermissionSettingsSourceName(state.record.agent)} settings`
      : known
        ? MODE_COPY[known].label
        : shown === 'plan'
          ? 'Plan mode'
          : shown === 'read-only'
            ? 'Read only'
            : (shown ?? 'Permissions')
  // A pick the running child has not applied yet takes effect with the next message. Hosts
  // without a running report only prove Claude's, which applies a pick by restarting.
  const running =
    state.runningPermissionMode ??
    (state.record.agent === 'claude' ? state.launchPermissionMode : undefined)
  const activeValue = running !== undefined && running !== current ? running : undefined
  return {
    description: label,
    id: AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
    label: 'Permissions',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: current,
      ...(reportedValue !== undefined ? { reportedValue } : {}),
      settingsAgent: state.record.agent,
      choices: support.modes.map((value) => ({
        value,
        ...agentChatPermissionModeCopy(state.record.agent, value)
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

/** A primitive per answer, so subscribers re-render only when it changes: no evidence, cleared (undefined), or the reported mode.
 *  A newer fence's report is current: the first child starts above the fence the chat attached at. An older fence's report
 *  says nothing about this attachment, so the options fallback stands. */
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
    fence === null ||
    !('mode' in report)
  ) {
    return undefined
  }
  if (report.fence < fence) {
    return NO_RUNTIME_PERMISSION_REPORT
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
