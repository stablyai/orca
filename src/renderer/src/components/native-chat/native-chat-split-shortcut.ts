import {
  canonicalizeParsedKeybinding,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction,
  parseKeybinding,
  type KeybindingActionId,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../../../shared/keybindings'

export type NativeChatSplitDirection = 'right' | 'down'

export type NativeChatSplitShortcut = {
  direction: NativeChatSplitDirection
  opensTerminal: boolean
}

const SPLIT_SHORTCUTS: readonly [KeybindingActionId, NativeChatSplitShortcut][] = [
  ['chat.splitTerminalRight', { direction: 'right', opensTerminal: true }],
  ['chat.splitTerminalDown', { direction: 'down', opensTerminal: true }],
  ['terminal.splitRight', { direction: 'right', opensTerminal: false }],
  ['terminal.splitDown', { direction: 'down', opensTerminal: false }]
]

export function matchNativeChatSplitShortcut(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides
): NativeChatSplitShortcut | null {
  const match = SPLIT_SHORTCUTS.find(([actionId]) =>
    keybindingMatchesAction(actionId, input, platform, keybindings)
  )
  return match?.[1] ?? null
}

function canonicalBinding(binding: string): string {
  const parsed = parseKeybinding(binding)
  return parsed ? canonicalizeParsedKeybinding(parsed) : binding
}

export function nativeChatSplitShortcutLabels(
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides
): Record<NativeChatSplitDirection, string> {
  const bindingsFor = (actionId: KeybindingActionId): string[] =>
    getEffectiveKeybindingsForAction(actionId, platform, keybindings)
  const claimed = new Set(
    SPLIT_SHORTCUTS.filter(([, split]) => split.opensTerminal)
      .flatMap(([actionId]) => bindingsFor(actionId))
      .map(canonicalBinding)
  )
  const label = (actionId: KeybindingActionId): string => {
    const bindings = bindingsFor(actionId).filter(
      (binding) => !claimed.has(canonicalBinding(binding))
    )
    return bindings.length > 0 ? formatKeybindingList(bindings, platform) : ''
  }
  return { right: label('terminal.splitRight'), down: label('terminal.splitDown') }
}
