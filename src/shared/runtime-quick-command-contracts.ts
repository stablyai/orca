import type { TerminalQuickCommand } from './terminal-quick-command-types'

export type RuntimeQuickCommandList = {
  quickCommands: TerminalQuickCommand[]
  repoId: string | null
}

export type RuntimeQuickCommandShow = {
  quickCommand: TerminalQuickCommand
}

export type RuntimeQuickCommandMutation = {
  quickCommand: TerminalQuickCommand
  quickCommands: TerminalQuickCommand[]
}

export type RuntimeQuickCommandRemoval = {
  removed: TerminalQuickCommand
  quickCommands: TerminalQuickCommand[]
}
