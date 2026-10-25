// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchAppMenuSelectionAction } from '@/lib/app-menu-selection-actions'
import { registerTerminalPanePasteListeners } from './terminal-pane-paste-listeners'

/** Mounts a focused pane with the given platform and kitty flags, and registers its listeners. */
function mountPane(isMac: boolean, kittyFlags: number) {
  const container = document.createElement('div')
  const textarea = document.createElement('div')
  textarea.tabIndex = 0
  container.append(textarea)
  document.body.append(container)
  textarea.focus()
  const terminal = { selectAll: vi.fn(), input: vi.fn(), getSelection: () => '' }
  const pane = { id: 1, leafId: 'leaf-1', terminal }
  const dispose = registerTerminalPanePasteListeners({
    container,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the select-all menu path reads only these controller fields.
    controller: {
      forceBracketedMultilineTextPaste: false,
      keybindings: undefined,
      managerRef: { current: { getActivePane: () => pane, getPanes: () => [pane] } },
      paneKittyKeyboardModesRef: { current: new Map([[1, { flags: kittyFlags }]]) },
      paneTransportsRef: { current: new Map() },
      setTerminalError: vi.fn(),
      worktreeId: 'worktree-1'
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: paste execution is unused by the select-all menu path.
    execution: { executePanePasteText: vi.fn(), pasteFromClipboard: vi.fn() } as never,
    isMac,
    shortcutPlatform: isMac ? 'darwin' : 'linux'
  })
  return { terminal, dispose }
}

describe('Edit > Select All in a terminal pane', () => {
  let dispose: (() => void) | undefined
  afterEach(() => {
    dispose?.()
    dispose = undefined
    document.body.replaceChildren()
  })

  it('forwards Cmd+A to a kitty-keyboard app instead of selecting the scrollback', () => {
    const pane = mountPane(true, 1)
    dispose = pane.dispose

    expect(dispatchAppMenuSelectionAction('select-all')).toBe(true)
    expect(pane.terminal.input).toHaveBeenCalledWith('\x1b[97;9u')
    expect(pane.terminal.selectAll).not.toHaveBeenCalled()
  })

  it('selects the scrollback when no kitty flags are active', () => {
    const pane = mountPane(true, 0)
    dispose = pane.dispose

    expect(dispatchAppMenuSelectionAction('select-all')).toBe(true)
    expect(pane.terminal.selectAll).toHaveBeenCalledTimes(1)
    expect(pane.terminal.input).not.toHaveBeenCalled()
  })

  it('keeps select-all off macOS even with kitty flags', () => {
    const pane = mountPane(false, 1)
    dispose = pane.dispose

    expect(dispatchAppMenuSelectionAction('select-all')).toBe(true)
    expect(pane.terminal.selectAll).toHaveBeenCalledTimes(1)
    expect(pane.terminal.input).not.toHaveBeenCalled()
  })
})
