import {
  keybindingMatchesAction,
  type KeybindingMatchOptions,
  type KeybindingOverrides
} from './keybindings'

export function nativeZoomCommandMatchesKeybindings(
  direction: 'in' | 'out',
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides,
  options: KeybindingMatchOptions = {}
): boolean {
  const primary =
    platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
  const actionId = direction === 'in' ? 'zoom.in' : 'zoom.out'
  const candidates =
    direction === 'in'
      ? [
          { key: '=', code: 'Equal', shift: false },
          { key: '+', code: 'Equal', shift: true },
          { key: 'Add', code: 'NumpadAdd', shift: false }
        ]
      : [
          { key: '-', code: 'Minus', shift: false },
          { key: 'Subtract', code: 'NumpadSubtract', shift: false }
        ]

  return candidates.some((candidate) =>
    keybindingMatchesAction(
      actionId,
      { ...primary, alt: false, ...candidate },
      platform,
      keybindings,
      options
    )
  )
}
