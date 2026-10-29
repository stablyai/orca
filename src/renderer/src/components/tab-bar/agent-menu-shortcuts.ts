import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  getKeybindingConflictIdentity,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { listBoundAgentTabActions } from '@/lib/agent-tab-shortcuts'

export type AgentMenuShortcuts = {
  label: (agent: TuiAgent, isDefault: boolean) => string | null
}

/** Mirror resolveTerminalAgentTabShortcut's match order so a row only lists chords that launch it: tab.newAgent wins, then per-agent chords in catalog order. */
export function resolveAgentMenuShortcuts(
  keybindings: KeybindingOverrides | undefined,
  disabledTuiAgents: readonly TuiAgent[] | null | undefined,
  platform: NodeJS.Platform
): AgentMenuShortcuts {
  const common = getEffectiveKeybindingsForAction('tab.newAgent', platform, keybindings)
  const claimed = new Set(common.map((binding) => getKeybindingConflictIdentity(binding, platform)))
  const byAgent = new Map<TuiAgent, string[]>()
  for (const { agent, actionId } of listBoundAgentTabActions(keybindings, disabledTuiAgents)) {
    const live: string[] = []
    for (const binding of getEffectiveKeybindingsForAction(actionId, platform, keybindings)) {
      const identity = getKeybindingConflictIdentity(binding, platform)
      if (!claimed.has(identity)) {
        claimed.add(identity)
        live.push(binding)
      }
    }
    byAgent.set(agent, live)
  }
  return {
    label: (agent, isDefault) => {
      const bindings = [...(byAgent.get(agent) ?? []), ...(isDefault ? common : [])]
      return bindings.length > 0 ? formatKeybindingList(bindings, platform) : null
    }
  }
}
