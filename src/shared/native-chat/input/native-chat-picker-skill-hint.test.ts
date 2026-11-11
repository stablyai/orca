import { describe, expect, it } from 'vitest'
import type { AgentSessionSlashCommand } from '../../agent-session/agent-session-wire'
import type { DiscoveredSkill } from '../../skills'
import { buildNativeChatPickerItems } from './native-chat-picker-items'
import { sessionReportedSkills, sessionSlashCommandSuggestions } from './native-chat-slash-commands'

const scannedDemo: DiscoveredSkill = {
  id: 'home:demo',
  name: 'demo',
  description: 'Demo skill',
  providers: ['claude'],
  sourceKind: 'home',
  sourceLabel: 'Home',
  rootPath: '/home/u/.claude/skills',
  directoryPath: '/home/u/.claude/skills/demo',
  skillFilePath: '/home/u/.claude/skills/demo/SKILL.md',
  installed: true,
  updatedAt: null
}

function skillHints(reported: AgentSessionSlashCommand[]): Record<string, string | undefined> {
  const items = buildNativeChatPickerItems(
    sessionSlashCommandSuggestions('claude', reported),
    [scannedDemo],
    '',
    '/',
    sessionReportedSkills(reported, 'claude')
  )
  return Object.fromEntries(
    items.flatMap((item) => (item.kind === 'skill' ? [[item.name, item.argumentHint]] : []))
  )
}

describe('skill argument hints in the native chat picker', () => {
  it('shows the hint the session reports for a skill', () => {
    expect(
      skillHints([
        { name: 'demo', kind: 'skill', argumentHint: '<target>' },
        {
          name: 'plan',
          kind: 'skill',
          argumentHint: '[plan|implement] [ref ...]',
          path: '/home/u/.claude/skills/plan/SKILL.md'
        }
      ])
    ).toEqual({ demo: '<target>', plan: '[plan|implement] [ref ...]' })
  })

  it('keeps the hint before the session has classified its catalog', () => {
    expect(
      skillHints([
        { name: 'demo', kind: 'command', kindUnspecified: true, argumentHint: '<target>' }
      ])
    ).toEqual({ demo: '<target>' })
  })
})
