// Show host-stated permission mode; never infer what is running.

import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
  chatModelSupportsAutoMode,
  offeredChatPermissionModes,
  type AgentChatPermissionMode
} from './agent-chat-permission-mode'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { StructuredAgentSessionOptionRecord } from './structured-agent-session-option-state'
import type { SessionOptionDescriptor } from './native-chat-session-options'

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

const CODEX_DESCRIPTIONS: Partial<Record<AgentChatPermissionMode, string>> = {
  ask: 'Edits files and runs commands in this workspace; asks before anything else',
  'full-access': 'Never asks; can edit any file and use the network'
}

// Claude's copy names the person's own settings; other agents decide what they already allow.
const OTHER_AGENT_DESCRIPTIONS: Partial<Record<AgentChatPermissionMode, string>> = {
  ask: "Asks before edits or commands it isn't already allowed to make"
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

function currentModelSupportsAutoMode(
  catalog: AgentSessionOptionCatalog | null,
  record: StructuredAgentSessionOptionRecord
): boolean {
  const model = record.values.model?.value
  return (
    catalog !== null &&
    chatModelSupportsAutoMode(catalog.models, typeof model === 'string' ? model : undefined)
  )
}

export function structuredAgentSessionPermissionDescriptor(state: {
  catalog: AgentSessionOptionCatalog | null
  record: StructuredAgentSessionOptionRecord
  permissionMode: string | null
  pendingId?: string | null
}): SessionOptionDescriptor | null {
  const support = agentChatPermissionModes(state.record.agent)
  const current = support?.modes.find((mode) => mode === state.permissionMode)
  if (!support || !current) {
    return null
  }
  const offered = offeredChatPermissionModes(
    support,
    current === 'auto' ||
      (state.pendingId !== 'model' && currentModelSupportsAutoMode(state.catalog, state.record))
  )
  return {
    id: AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
    label: 'Permissions',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: current,
      choices: offered.map((value) => ({
        value,
        label: MODE_COPY[value].label,
        description: agentDescriptions(state.record.agent)[value] ?? MODE_COPY[value].description
      }))
    },
    valueSource: 'applied',
    transport: 'agent-session',
    settable: true
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
