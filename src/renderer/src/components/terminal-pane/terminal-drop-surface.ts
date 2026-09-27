import type { Terminal } from '@xterm/xterm'
import type { PtyTransport } from './pty-transport'

export type TerminalDropPane = {
  id: number
  leafId: string
  container: HTMLElement
  terminal: Pick<Terminal, 'focus'>
}

export type TerminalDropSurface = {
  getPanes: () => TerminalDropPane[]
  getActivePane: () => TerminalDropPane | null
}

export type TerminalDropTransport = Pick<
  PtyTransport,
  'getPtyId' | 'isConnected' | 'sendInput' | 'sendInputAccepted'
>
