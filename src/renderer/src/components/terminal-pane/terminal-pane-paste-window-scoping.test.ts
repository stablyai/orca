// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_SELECTION_ACTION_EVENT } from '../../lib/app-menu-selection-actions'
import { registerTerminalPanePasteListeners } from './terminal-pane-paste-listeners'

describe('terminal pane app-menu window scoping', () => {
  let iframe: HTMLIFrameElement | null = null
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
    iframe?.remove()
    iframe = null
    vi.restoreAllMocks()
  })

  it('receives app-menu selection actions on the container window, not the global one', () => {
    iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const childWin = iframe.contentWindow!
    const container = childWin.document.createElement('div')
    const inner = childWin.document.createElement('div')
    inner.tabIndex = -1
    container.appendChild(inner)
    childWin.document.body.appendChild(container)

    const selectAll = vi.fn()
    const manager = {
      getActivePane: () => ({ terminal: { selectAll, getSelection: () => '' } }),
      getPanes: () => []
    }
    cleanup = registerTerminalPanePasteListeners({
      container: container as unknown as HTMLDivElement,
      controller: { managerRef: { current: manager } } as never,
      execution: { executePanePasteText: vi.fn(), pasteFromClipboard: vi.fn() } as never,
      isMac: false,
      shortcutPlatform: 'linux'
    })

    // Why: selection actions consult the focused element — focus the pane child first.
    inner.focus()
    childWin.dispatchEvent(
      new CustomEvent(APP_MENU_SELECTION_ACTION_EVENT, { detail: 'select-all' })
    )
    expect(selectAll).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new CustomEvent(APP_MENU_SELECTION_ACTION_EVENT, { detail: 'select-all' }))
    expect(selectAll).toHaveBeenCalledTimes(1)

    cleanup()
    cleanup = null
    childWin.dispatchEvent(
      new CustomEvent(APP_MENU_SELECTION_ACTION_EVENT, { detail: 'select-all' })
    )
    expect(selectAll).toHaveBeenCalledTimes(1)
  })
})
