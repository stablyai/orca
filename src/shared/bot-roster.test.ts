import { describe, expect, it } from 'vitest'
import {
  botAddressArgument,
  botOfAddress,
  formatBotRosterEntry,
  parseBotAddress,
  soulSpecialty
} from './bot-roster'
import { starterSoul } from './bot-soul'

describe('soulSpecialty', () => {
  it('is the first paragraph under the title', () => {
    expect(
      soulSpecialty('# Docs\n\nKeeps the docs site\ncurrent.\n\n## How I work\n\n- terse')
    ).toBe('Keeps the docs site current.')
  })

  it('is null for an empty, missing or starter soul', () => {
    expect(soulSpecialty(null)).toBeNull()
    expect(soulSpecialty('  \n')).toBeNull()
    expect(soulSpecialty(starterSoul('Docs'))).toBeNull()
    expect(soulSpecialty('# Docs\n\n## How I work')).toBeNull()
  })

  it('cuts a long one at a word, never inside a character', () => {
    const long = `${'word '.repeat(40)}end`
    const cut = soulSpecialty(long)!
    expect(Array.from(cut).length).toBeLessThanOrEqual(120)
    expect(cut.endsWith('word…')).toBe(true)
    const emoji = soulSpecialty('😀'.repeat(200))!
    expect(Array.from(emoji)).toHaveLength(120)
    expect(emoji.endsWith('😀…')).toBe(true)
  })

  it('drops control characters', () => {
    expect(soulSpecialty('Docs\u0007 bot')).toBe('Docs  bot')
  })
})

describe('bot addresses', () => {
  const bots = [
    { id: 'id-1', name: 'Docs' },
    { id: 'id-2', name: 'Release Notes' }
  ]

  it('reads bot:<name> in any case, and nothing else', () => {
    expect(parseBotAddress('bot:Docs')).toBe('Docs')
    expect(parseBotAddress('BOT:Release Notes')).toBe('Release Notes')
    expect(parseBotAddress('bot:')).toBeNull()
    expect(parseBotAddress('run:abc')).toBeNull()
  })

  it('finds a bot by id or by name in any case', () => {
    expect(botOfAddress(bots, 'id-2')?.name).toBe('Release Notes')
    expect(botOfAddress(bots, 'docs')?.id).toBe('id-1')
    expect(botOfAddress(bots, 'Ranger')).toBeNull()
  })

  it('quotes a name a shell would split', () => {
    expect(botAddressArgument('Docs')).toBe('bot:Docs')
    expect(botAddressArgument('Release Notes')).toBe('"bot:Release Notes"')
    expect(botAddressArgument('a"$b')).toBe('"bot:a\\"\\$b"')
  })
})

describe('formatBotRosterEntry', () => {
  it('prints the Chats line as one line', () => {
    const lines = formatBotRosterEntry({
      id: 'id-1',
      name: 'Docs',
      agent: 'codex',
      paused: false,
      specialty: null,
      linked: [],
      chats: { count: 2, home: true }
    }).split('\n')
    expect(lines.filter((line) => line.trim().startsWith('Chats:'))).toEqual([
      '  Chats: 2 (Home plus 1 other; list them with: orca bot chats --bot "Docs")'
    ])
  })

  it("prints a paired server's bot with its computer and the --on that reaches it", () => {
    const lines = formatBotRosterEntry({
      id: 'id-2',
      name: 'Bot-Release-Manager',
      agent: 'codex',
      paused: false,
      specialty: null,
      linked: [],
      server: { name: 'm4 air', on: 'm4 air' }
    }).split('\n')
    expect(lines[1]).toBe(`  On: "m4 air"; send with --on 'm4 air' --to bot:Bot-Release-Manager`)
  })
})
