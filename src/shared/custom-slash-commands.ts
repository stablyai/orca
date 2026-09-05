// Claude Code custom slash commands: markdown files under `<repo>/.claude/commands`
// and `~/.claude/commands`. The TUI lists them next to its built-ins, so Orca's
// chat picker has to discover them rather than curate them.

import { isTokenSafeName, stripUnsafeDisplayCharacters } from './skill-display-text'

export type CustomSlashCommandScope = 'project' | 'user'

export type DiscoveredSlashCommand = {
  /** Invocation token without the leading slash, e.g. `opsx:apply`. */
  name: string
  description: string | null
  scope: CustomSlashCommandScope
  /** Absolute path of the markdown file that defines the command. */
  commandFilePath: string
}

export const CUSTOM_SLASH_COMMAND_DESCRIPTION_MAX_LENGTH = 240

/** `git/pr.md` -> `git:pr`. Subdirectories are the namespace, exactly as Claude
 *  Code spells them. Null when the path cannot be typed back as a slash token. */
export function customSlashCommandName(relativePath: string): string | null {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean)
  const fileName = segments.pop()
  if (!fileName || !/\.md$/i.test(fileName)) {
    return null
  }
  const name = [...segments, fileName.slice(0, -'.md'.length)].join(':')
  return isTokenSafeName(name) ? name : null
}

/** Frontmatter is author-controlled text rendered in the picker, so it is
 *  stripped and bounded before it reaches a row. */
export function sanitizeCustomSlashCommandDescription(
  description: string | null | undefined
): string | undefined {
  if (!description) {
    return undefined
  }
  const safe = stripUnsafeDisplayCharacters(description)
    .slice(0, CUSTOM_SLASH_COMMAND_DESCRIPTION_MAX_LENGTH)
    .trim()
  return safe || undefined
}

/** Project scope shadows user scope on a name collision, matching Claude Code. */
export function dedupeCustomSlashCommands(
  commands: readonly DiscoveredSlashCommand[]
): DiscoveredSlashCommand[] {
  const byName = new Map<string, DiscoveredSlashCommand>()
  for (const command of commands) {
    const existing = byName.get(command.name)
    if (!existing || (existing.scope === 'user' && command.scope === 'project')) {
      byName.set(command.name, command)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
