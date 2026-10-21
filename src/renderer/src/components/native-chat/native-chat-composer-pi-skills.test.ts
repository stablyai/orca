import { describe, expect, it } from 'vitest'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import {
  sessionReportedSkills,
  sessionSlashCommandSuggestions
} from '../../../../shared/native-chat-slash-commands'
import { applyPickerSuggestion, deriveComposerAutocomplete } from './native-chat-composer-state'
import type { DiscoveredSkill } from '../../../../shared/skills'

const profile = getNativeChatAgentProfile('pi')
const reported = [
  { kind: 'command' as const, name: 'review', description: 'Review prompt template' },
  { kind: 'skill' as const, name: 'skill:review', description: 'Pi review skill' }
]
const scanned: DiscoveredSkill = {
  id: 'pi-review',
  name: 'review',
  description: 'Pi review skill',
  providers: ['agent-skills'],
  sourceKind: 'home',
  sourceLabel: 'Pi home',
  rootPath: '/home/test/.pi/agent/skills',
  directoryPath: '/home/test/.pi/agent/skills/review',
  skillFilePath: '/home/test/.pi/agent/skills/review/SKILL.md',
  installed: true,
  updatedAt: null
}

describe('Pi composer skills', () => {
  it('offers a host-reported skill when the SSH disk scan is unavailable', () => {
    const result = deriveComposerAutocomplete(
      '/',
      1,
      sessionSlashCommandSuggestions('pi', reported),
      [],
      profile,
      { status: 'error', skills: [], errorKind: 'unavailable' },
      null,
      sessionReportedSkills(reported)
    )
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.skillsEnabled).toBe(true)
    expect(result.items.map(({ kind, name, token }) => ({ kind, name, token }))).toEqual([
      { kind: 'command', name: 'review', token: '/review' },
      { kind: 'skill', name: 'review', token: '/skill:review' }
    ])
    const skill = result.items.find((item) => item.kind === 'skill')
    expect(skill).toMatchObject({ description: 'Pi review skill', sources: [] })
    if (!skill) {
      return
    }
    expect(applyPickerSuggestion('/', 1, skill).draft).toBe('/skill:review ')
  })

  it('writes a scanned Pi skill with the same invocation token as its session report', () => {
    const result = deriveComposerAutocomplete('/', 1, [], [scanned], profile)
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.items.map(({ token }) => token)).toEqual(['/skill:review'])
  })

  it('merges reported Pi skill names with disk metadata without doubling the namespace', () => {
    const result = deriveComposerAutocomplete(
      '/rev',
      4,
      [],
      [scanned],
      profile,
      undefined,
      null,
      sessionReportedSkills(reported)
    )
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: 'skill',
        name: 'review',
        token: '/skill:review',
        sources: [{ sourceKind: 'home', skillFilePath: scanned.skillFilePath }]
      })
    ])
  })

  it('keeps an extension command that owns the exact skill invocation token', () => {
    const result = deriveComposerAutocomplete(
      '/',
      1,
      [{ name: 'skill:review' }],
      [scanned],
      profile
    )
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.items).toEqual([
      expect.objectContaining({ kind: 'command', token: '/skill:review', skillCollision: true })
    ])
  })

  it('keeps same-named Pi skill files distinct without adding an unlocated duplicate', () => {
    const otherPath = '/workspace/.pi/skills/review/SKILL.md'
    const result = deriveComposerAutocomplete(
      '/rev',
      4,
      [],
      [scanned],
      profile,
      undefined,
      null,
      sessionReportedSkills([
        { kind: 'skill', name: 'skill:review', path: scanned.skillFilePath },
        { kind: 'skill', name: 'skill:review', path: otherPath, description: 'Workspace review' }
      ])
    )
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.items).toEqual([
      expect.objectContaining({
        id: `skill:${scanned.skillFilePath}`,
        name: 'review',
        token: '/skill:review',
        path: scanned.skillFilePath,
        location: scanned.skillFilePath,
        description: 'Pi review skill',
        sources: [{ sourceKind: 'home', skillFilePath: scanned.skillFilePath }]
      }),
      expect.objectContaining({
        id: `skill:${otherPath}`,
        name: 'review',
        token: '/skill:review',
        path: otherPath,
        location: otherPath,
        description: 'Workspace review',
        sources: []
      })
    ])
  })

  it('keeps unsupported agents from gaining an unverified skill grammar', () => {
    const result = deriveComposerAutocomplete(
      '/',
      1,
      [{ name: 'help' }],
      [scanned],
      getNativeChatAgentProfile('custom-agent'),
      undefined,
      null,
      [{ name: 'skill:review' }]
    )
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.items.map(({ kind }) => kind)).toEqual(['command'])
    expect(result.skillsEnabled).toBe(false)
  })
})
