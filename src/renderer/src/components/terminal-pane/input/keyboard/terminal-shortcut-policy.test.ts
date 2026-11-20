import { describe, expect, it } from 'vitest'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'

function resolveLinuxCtrlArrow(key: 'ArrowLeft' | 'ArrowRight', kittyFlags: number) {
  return resolveTerminalShortcutAction(
    { key, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
    false,
    'false',
    0,
    false,
    undefined,
    undefined,
    () => kittyFlags
  )
}

describe('resolveTerminalShortcutAction ctrl+arrow', () => {
  it('lets xterm encode ctrl+arrow as CSI 1;5D/C when the pane negotiated the kitty protocol', () => {
    expect(resolveLinuxCtrlArrow('ArrowLeft', 15)).toBeNull()
  })

  it('keeps the readline \\eb/\\ef translation when kitty flags are not active', () => {
    expect(resolveLinuxCtrlArrow('ArrowLeft', 0)).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(resolveLinuxCtrlArrow('ArrowRight', 0)).toEqual({ type: 'sendInput', data: '\x1bf' })
  })
})
