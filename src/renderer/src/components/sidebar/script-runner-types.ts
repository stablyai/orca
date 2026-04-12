import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { PtyTransport } from '@/components/terminal-pane/pty-transport'

export type PackageScripts = Record<string, string>

export type RunningScript = {
  id: number
  name: string
  command: string
  terminal: Terminal
  fitAddon: FitAddon
  transport: PtyTransport
  exited: boolean
  exitCode: number | null
}

let _nextScriptId = 0

export function getNextScriptId(): number {
  return _nextScriptId++
}
