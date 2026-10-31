// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { anotherTerminalOwnsFocus } from './pane-helpers'
import { refreshTerminalImeInputContext } from './terminal-ime-input-context-refresh'

function mountTerminal(): { container: HTMLElement; helper: HTMLTextAreaElement } {
  const container = document.createElement('div')
  const xterm = document.createElement('div')
  xterm.className = 'xterm'
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  xterm.append(helper)
  container.append(xterm)
  document.body.append(container)
  return { container, helper }
}

function managerOwning(
  ...containers: HTMLElement[]
): Parameters<typeof anotherTerminalOwnsFocus>[0] {
  return { getPanes: () => containers.map((container) => ({ container })) }
}

describe('anotherTerminalOwnsFocus', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('treats a foreign helper awaiting its IME refocus frame as the focus owner', () => {
    const own = mountTerminal()
    const foreign = mountTerminal()
    foreign.helper.focus()
    const scheduled: (() => void)[] = []
    refreshTerminalImeInputContext(foreign.helper, {
      isMac: true,
      scheduleRefocus: (callback) => scheduled.push(callback)
    })
    expect(document.activeElement).toBe(document.body)

    expect(anotherTerminalOwnsFocus(managerOwning(own.container))).toBe(true)

    for (const run of scheduled) {
      run()
    }
    expect(document.activeElement).toBe(foreign.helper)
    expect(anotherTerminalOwnsFocus(managerOwning(foreign.container))).toBe(false)
  })

  it('is true when the focused xterm helper belongs to a pane outside this manager', () => {
    const own = mountTerminal()
    const foreign = mountTerminal()
    foreign.helper.focus()

    expect(anotherTerminalOwnsFocus(managerOwning(own.container))).toBe(true)
  })

  it('is false when the focused helper belongs to one of the owned panes', () => {
    const own = mountTerminal()
    own.helper.focus()

    expect(anotherTerminalOwnsFocus(managerOwning(own.container))).toBe(false)
  })

  it('is false for non-terminal focus and for no focus at all', () => {
    const own = mountTerminal()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(anotherTerminalOwnsFocus(managerOwning(own.container))).toBe(false)

    input.blur()
    expect(anotherTerminalOwnsFocus(managerOwning(own.container))).toBe(false)
  })
})
