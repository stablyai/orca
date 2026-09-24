import type { IDisposable, Terminal } from '@xterm/xterm'

// Structural so the capability-reply installer keeps its narrow Pick, but narrow
// enough that a non-terminal wrapper cannot become a second, never-refreshed key.
type Da1OwnerTerminal = Pick<Terminal, 'cols' | 'rows' | 'element' | 'options'>

const owners = new WeakMap<Da1OwnerTerminal, { refresh: () => void }>()

/** Keep Orca's replay-aware DA1 responder after subsequently attached addons. */
export function registerTerminalDa1Owner(
  terminal: Da1OwnerTerminal,
  register: () => IDisposable
): IDisposable {
  let handler = register()
  const owner = {
    refresh: () => {
      handler.dispose()
      handler = register()
    }
  }
  owners.set(terminal, owner)
  return {
    dispose: () => {
      handler.dispose()
      if (owners.get(terminal) === owner) {
        owners.delete(terminal)
      }
    }
  }
}

export function refreshTerminalDa1Owner(terminal: Da1OwnerTerminal): void {
  owners.get(terminal)?.refresh()
}
