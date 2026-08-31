import { describe, expect, it } from 'vitest'
import {
  customSlashCommandName,
  dedupeCustomSlashCommands,
  sanitizeCustomSlashCommandDescription,
  type DiscoveredSlashCommand
} from './custom-slash-commands'

function command(
  name: string,
  scope: DiscoveredSlashCommand['scope'],
  commandFilePath = `/${name}.md`
): DiscoveredSlashCommand {
  return { name, description: null, scope, commandFilePath }
}

describe('customSlashCommandName', () => {
  it('drops the .md extension for a top-level command', () => {
    expect(customSlashCommandName('review.md')).toBe('review')
  })

  it('namespaces subdirectories with colons like Claude Code', () => {
    expect(customSlashCommandName('opsx/apply.md')).toBe('opsx:apply')
    expect(customSlashCommandName('git/pr/open.md')).toBe('git:pr:open')
  })

  it('accepts Windows separators', () => {
    expect(customSlashCommandName('opsx\\apply.md')).toBe('opsx:apply')
  })

  it('ignores files that are not markdown', () => {
    expect(customSlashCommandName('notes.txt')).toBeNull()
    expect(customSlashCommandName('README')).toBeNull()
  })

  it('rejects names that cannot be typed back as one slash token', () => {
    expect(customSlashCommandName('my command.md')).toBeNull()
    expect(customSlashCommandName('bad‮name.md')).toBeNull()
    expect(customSlashCommandName(`${'a'.repeat(201)}.md`)).toBeNull()
  })
})

describe('sanitizeCustomSlashCommandDescription', () => {
  it('strips control and bidi characters from author-controlled text', () => {
    expect(sanitizeCustomSlashCommandDescription('safe‮desc')).toBe('safedesc')
  })

  it('bounds the description length', () => {
    expect(sanitizeCustomSlashCommandDescription('x'.repeat(400))).toHaveLength(240)
  })

  it('returns undefined for empty or missing text', () => {
    expect(sanitizeCustomSlashCommandDescription(null)).toBeUndefined()
    expect(sanitizeCustomSlashCommandDescription('   ')).toBeUndefined()
  })
})

describe('dedupeCustomSlashCommands', () => {
  it('lets project scope shadow the user-level command of the same name', () => {
    const merged = dedupeCustomSlashCommands([
      command('apply', 'user', '/home/.claude/commands/apply.md'),
      command('apply', 'project', '/repo/.claude/commands/apply.md')
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].commandFilePath).toBe('/repo/.claude/commands/apply.md')
  })

  it('keeps user commands that the project does not define, sorted by name', () => {
    const merged = dedupeCustomSlashCommands([command('zeta', 'user'), command('alpha', 'project')])
    expect(merged.map((entry) => entry.name)).toEqual(['alpha', 'zeta'])
  })
})
