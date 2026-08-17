import type { ManagedPaneInternal } from './pane-manager-types'

const observers = new WeakMap<ManagedPaneInternal, MutationObserver>()

export function observePaneTerminalBackground(pane: ManagedPaneInternal): void {
  disposePaneTerminalBackgroundObserver(pane)
  const terminalElement = pane.terminal.element
  if (!terminalElement) {
    return
  }

  let previous = ''
  const sync = () => {
    const background = terminalElement.style.backgroundColor
    if (!background || background === previous) {
      return
    }
    previous = background
    pane.xtermContainer.style.setProperty('--orca-terminal-live-background', background)
  }
  const observer = new MutationObserver(sync)
  observer.observe(terminalElement, { attributes: true, attributeFilter: ['style'] })
  observers.set(pane, observer)
  sync()
}

export function disposePaneTerminalBackgroundObserver(pane: ManagedPaneInternal): void {
  observers.get(pane)?.disconnect()
  observers.delete(pane)
}
