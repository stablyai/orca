import { searchTerminalQuickCommands } from '@/lib/terminal-quick-command-search'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

export function searchHostedTerminalQuickCommands(
  entries: readonly HostedTerminalQuickCommand[],
  query: string
): HostedTerminalQuickCommand[] {
  const entryByCommand = new Map(entries.map((entry) => [entry.command, entry]))
  return searchTerminalQuickCommands(
    entries.map((entry) => entry.command),
    query
  ).flatMap((command) => entryByCommand.get(command) ?? [])
}
