import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { KeybindingInput } from '../../../../shared/keybindings'
import { handleNativeChatPaneShortcut } from './native-chat-pane-shortcut'

const cmdShiftY = { key: 'Y', code: 'KeyY', metaKey: true, shiftKey: true }
const equalizeOnCmdShiftY = { 'terminal.equalizePaneSizes': ['Mod+Shift+Y'] }

function keyDown(input: KeybindingInput) {
  return { repeat: false, ...input, preventDefault: vi.fn(), stopPropagation: vi.fn() }
}

function terminalPaneActions(canEqualizePaneSizes: boolean) {
  return {
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    canEqualizePaneSizes,
    onEqualizePaneSizes: vi.fn()
  }
}

beforeEach(() => vi.stubGlobal('navigator', { userAgent: 'Macintosh' }))
afterEach(() => vi.unstubAllGlobals())

it('Cmd+Shift+Y in a chat dispatches the equalize callback', () => {
  const actions = terminalPaneActions(true)
  const event = keyDown(cmdShiftY)
  expect(handleNativeChatPaneShortcut(event, equalizeOnCmdShiftY, actions)).toBe(true)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(actions.onEqualizePaneSizes).toHaveBeenCalledOnce()
  expect(actions.onSplitRight).not.toHaveBeenCalled()
  expect(actions.onSplitDown).not.toHaveBeenCalled()
})

it('leaves the equalize key unconsumed when a lone or expanded pane cannot equalize', () => {
  const actions = terminalPaneActions(false)
  const event = keyDown(cmdShiftY)
  expect(handleNativeChatPaneShortcut(event, equalizeOnCmdShiftY, actions)).toBe(false)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(event.stopPropagation).not.toHaveBeenCalled()
  expect(actions.onEqualizePaneSizes).not.toHaveBeenCalled()
})
