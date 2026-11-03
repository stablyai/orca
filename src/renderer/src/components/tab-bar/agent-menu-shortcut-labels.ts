import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction,
  parseKeybinding,
  platformModifiers
} from '../../../../shared/keybindings'
import { resolveWindowShortcutAction } from '../../../../shared/window-shortcut-policy'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import {
  readAgentTabShortcutActions,
  resolveAgentTabShortcutAction
} from '../terminal-agent-tab-shortcut'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { NewTabAgentMenuModel } from './new-tab-agent-menu-model'

export function useAgentMenuShortcutLabels(
  model: NewTabAgentMenuModel | undefined
): Map<TuiAgent, string> | undefined {
  const keybindings = useAppStore((s) => s.keybindings)
  const worktreeId = model?.state === 'settled' ? model.pickerContext?.workspace.worktreeId : null
  return worktreeId
    ? agentMenuShortcutLabels(worktreeId, keybindings, getShortcutPlatform())
    : undefined
}

export function agentMenuShortcutLabels(
  worktreeId: string,
  keybindings: KeybindingOverrides,
  platform: NodeJS.Platform
): Map<TuiAgent, string> {
  const actions = readAgentTabShortcutActions(worktreeId, keybindings).map((action) => ({
    ...action
  }))
  const labels = new Map<TuiAgent, string[]>()
  for (const action of actions) {
    const agent = action.agent
    if (!agent) {
      continue
    }
    for (const binding of getEffectiveKeybindingsForAction(
      action.actionId,
      platform,
      keybindings
    )) {
      const parsed = parseKeybinding(binding)
      // Ordinary workspace listeners deliver raw key events, without a double-tap producer.
      if (!parsed || parsed.doubleTapModifier) {
        continue
      }
      // Numpad chords require their physical code; other keys match their own name.
      const key =
        parsed.key === 'NumpadAdd' ? '+' : parsed.key === 'NumpadSubtract' ? '-' : parsed.key
      const input = { key, code: parsed.key, ...platformModifiers(parsed, platform) }
      // Main claims its window shortcuts before the workspace listener sees the key.
      const opensAgent =
        !resolveWindowShortcutAction(input, platform, keybindings, { context: 'app' }) &&
        resolveAgentTabShortcutAction(actions, (actionId) =>
          keybindingMatchesAction(actionId, input, platform, keybindings, { context: 'app' })
        )?.agent === agent
      if (opensAgent) {
        const label = formatKeybindingList([binding], platform)
        labels.set(agent, [...new Set([...(labels.get(agent) ?? []), label])])
      }
    }
  }
  return new Map([...labels].map(([agent, chords]) => [agent, chords.join(', ')]))
}
