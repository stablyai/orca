import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { PtyTransport } from '@/components/terminal-pane/pty-transport'

/** The `scripts` map of a package.json, keyed by script name. */
export type PackageScripts = Record<string, string>

/** One script invocation and the terminal plus PTY transport driving it. */
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

/**
 * Hand out the next tab id for a script run.
 *
 * Ids only need to be unique within a session; tabs are keyed by them and the
 * counter is never persisted.
 */
export function getNextScriptId(): number {
  return _nextScriptId++
}
