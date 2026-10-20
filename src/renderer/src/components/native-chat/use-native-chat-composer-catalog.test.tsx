// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  buildNativeChatPickerItems,
  classifyPickerCommands
} from '../../../../shared/native-chat-picker-items'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import {
  isStructuredAgentSessionComposerCommand,
  STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
  structuredSlashCommands
} from '../../../../shared/structured-agent-session-composer'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { withNativeChatResumeCommand } from './use-native-chat-resume-command'

function transport(sessionCommands?: NativeChatStructuredComposerTransport['sessionCommands']) {
  return { sessionCommands } as NativeChatStructuredComposerTransport
}

describe('composer catalog authority', () => {
  it('keeps PTY and unsupported structured providers on their original catalogs', () => {
    const pty = renderHook(() => useNativeChatComposerCatalog('claude'))
    expect(pty.result.current.agentCommands).toEqual(getVerifiedNativeChatCommands('claude'))
    expect(pty.result.current.sessionSkills).toBeUndefined()
    const oldHost = renderHook(() => useNativeChatComposerCatalog('claude', transport()))
    expect(oldHost.result.current.agentCommands).toEqual(
      withNativeChatResumeCommand(structuredSlashCommands())
    )
    expect(oldHost.result.current.sessionSkills).toBeUndefined()
  })
  it('offers supported conversation commands when the host has no reported catalog', () => {
    const { result, rerender } = renderHook(
      ({ conversationCommands }) =>
        useNativeChatComposerCatalog('claude', { ...transport(), conversationCommands }),
      {
        initialProps: {
          conversationCommands: ['clear', 'compact'] as NonNullable<
            NativeChatStructuredComposerTransport['conversationCommands']
          >
        }
      }
    )
    expect(result.current.agentCommands.map(({ name }) => name)).toEqual([
      'model',
      'effort',
      'clear',
      'compact',
      'resume'
    ])
    rerender({ conversationCommands: ['clear'] })
    expect(result.current.agentCommands.map(({ name }) => name)).toEqual([
      'model',
      'effort',
      'clear',
      'resume'
    ])
  })
  // Codex reports no catalog, so the hook's fallback is its entire `/` menu; the
  // agent has to reach structuredSlashCommands or `/goal` is invisible there.
  it('offers Codex the commands its model runs from message text', () => {
    const { result } = renderHook(() => useNativeChatComposerCatalog('codex', transport()))
    expect(result.current.agentCommands).toEqual(
      withNativeChatResumeCommand(structuredSlashCommands([], 'codex'))
    )
    expect(result.current.agentCommands.map(({ name }) => name)).toContain('goal')
  })
  it("puts the host's commands ahead of what Claude reports, reported or not", () => {
    const reported = [{ name: 'init', kind: 'command' as const }]
    const withReport = renderHook(() => useNativeChatComposerCatalog('claude', transport(reported)))
    expect(withReport.result.current.agentCommands.map(({ name }) => name)).toEqual([
      'model',
      'effort',
      'init',
      'resume'
    ])
    const withoutReport = renderHook(() => useNativeChatComposerCatalog('claude', transport()))
    expect(withoutReport.result.current.agentCommands.map(({ name }) => name)).toEqual([
      'model',
      'effort',
      'resume'
    ])
  })
  it('respects empty catalogs and command-only catalogs without reviving disk skills', () => {
    const { result, rerender } = renderHook(
      ({ reported }) => useNativeChatComposerCatalog('claude', transport(reported)),
      {
        initialProps: {
          reported: [] as NonNullable<NativeChatStructuredComposerTransport['sessionCommands']>
        }
      }
    )
    expect(result.current).toEqual({
      agentCommands: withNativeChatResumeCommand(structuredSlashCommands()),
      sessionSkills: []
    })
    rerender({ reported: [{ name: 'custom-command', kind: 'command' }] })
    expect(result.current).toEqual({
      agentCommands: withNativeChatResumeCommand([
        ...structuredSlashCommands(),
        { name: 'custom-command' }
      ]),
      sessionSkills: []
    })
  })
  // Orca's /resume takes an agent command's place, but a skill of that name stays the agent's.
  it("puts Orca's /resume in place of an agent command and beside a namesake skill", () => {
    const reported = [
      { name: 'review', kind: 'command' as const },
      { name: 'resume', kind: 'command' as const, description: 'Resume a saved chat' },
      { name: 'resume', kind: 'skill' as const }
    ]
    const { result } = renderHook(() => useNativeChatComposerCatalog('claude', transport(reported)))
    const catalog = result.current
    const rows = (query: string) =>
      buildNativeChatPickerItems(catalog.agentCommands, [], query, '/', catalog.sessionSkills)
    expect(rows('').map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'command:model',
      'command:effort',
      'command:review',
      'command:resume',
      'skill:resume'
    ])
    expect(rows('r')[0]).toMatchObject({ name: 'review' })
    expect(rows('resume')[0]).toMatchObject({
      orcaOwned: true,
      description: 'Open Agent Session History',
      skillCollision: false
    })
  })
})

it('Enter completes a known pre-init skill while still dispatching a built-in command', () => {
  const reported = [
    { name: 'clear', kind: 'command' as const, kindUnspecified: true as const },
    { name: 'project-skill', kind: 'command' as const, kindUnspecified: true as const }
  ]
  const complete = vi.fn(),
    dispatch = vi.fn()
  const { result, rerender } = renderHook(
    ({ activeSuggestion }) => {
      const catalog = useNativeChatComposerCatalog('claude', transport(reported))
      const items = buildNativeChatPickerItems(
        catalog.agentCommands,
        [
          {
            id: 'project-skill',
            name: 'project-skill',
            description: 'Project skill',
            providers: ['claude'],
            sourceKind: 'repo',
            sourceLabel: 'Project',
            rootPath: '/project/.claude/skills',
            directoryPath: '/project/.claude/skills/project-skill',
            skillFilePath: '/project/.claude/skills/project-skill/SKILL.md',
            installed: true,
            updatedAt: null
          }
        ],
        '',
        '/',
        catalog.sessionSkills
      )
      return useNativeChatComposerKeyDown({
        autocomplete: {
          mode: 'slash',
          query: '',
          items,
          triggerKey: '/',
          prefix: '/',
          dispatchable: true,
          grouped: true,
          commandsEnabled: true,
          skillsEnabled: true,
          skillStatus: 'ready'
        },
        mentionFiles: { files: [], loading: false, failed: false },
        completeMention: vi.fn(),
        activeSuggestion,
        draft: '/',
        isComposing: () => false,
        completePickerItem: complete,
        dispatchPickerCommand: dispatch,
        dismissPicker: vi.fn(),
        interrupt: vi.fn(),
        send: vi.fn(),
        setActiveSuggestion: vi.fn(),
        setDraft: vi.fn(),
        setCaret: vi.fn()
      })
    },
    // Commands lead: the host's /model and /effort, clear, Orca's /resume, then the skill.
    { initialProps: { activeSuggestion: 4 } }
  )
  const enter = { key: 'Enter', nativeEvent: {}, preventDefault: vi.fn() } as unknown as Parameters<
    typeof result.current
  >[0]
  result.current(enter)
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'project-skill', kind: 'skill' })
  )
  expect(dispatch).not.toHaveBeenCalled()
  rerender({ activeSuggestion: 2 })
  result.current(enter)
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'clear', kind: 'command' }))
})

describe('OpenCode chat skills', () => {
  function skill(name: string, description: string): DiscoveredSkill {
    return {
      id: name,
      name,
      description,
      providers: ['agent-skills'],
      sourceKind: 'home',
      sourceLabel: 'OpenCode home',
      rootPath: '/Users/test/.config/opencode/skills',
      directoryPath: `/Users/test/.config/opencode/skills/${name}`,
      skillFilePath: `/Users/test/.config/opencode/skills/${name}/SKILL.md`,
      installed: true,
      updatedAt: null
    }
  }
  const scanned = [skill('release-notes', 'Write release notes')]
  // What the composer's picker builds: the reported catalog, classified against the scan.
  function items(
    agent: 'opencode' | 'opencode2' | 'claude',
    reported: { name: string; description?: string; kindUnspecified?: true }[],
    skills: DiscoveredSkill[] = scanned
  ) {
    const report = reported.map((command) => ({ ...command, kind: 'command' as const }))
    const { result } = renderHook(() => useNativeChatComposerCatalog(agent, transport(report)))
    const commands = classifyPickerCommands(result.current.agentCommands, skills, {
      reportMayListSkills: agent !== 'claude',
      isSendCommand: (name) => isStructuredAgentSessionComposerCommand(`/${name}`, agent)
    })
    // Orca's own rows sit in every structured catalog; these cases are about the agent's.
    const hostRows = new Set(STRUCTURED_AGENT_SESSION_SLASH_COMMANDS.map(({ name }) => name))
    return buildNativeChatPickerItems(
      commands,
      skills,
      '',
      '/',
      result.current.sessionSkills
    ).filter((item) => !(item.kind === 'command' && (item.orcaOwned || hostRows.has(item.name))))
  }
  const rows = (...args: Parameters<typeof items>) =>
    items(...args).map((item) => `${item.kind}:${item.name}`)

  // 2.x reports only these commands, so its running chats listed no skills at all.
  it('keeps the scanned skills once an OpenCode 2.x chat reports its commands', () => {
    expect(rows('opencode2', [{ name: 'init' }, { name: 'review' }])).toContain(
      'skill:release-notes'
    )
  })

  // 1.x reports each skill as a command too, under the skill's own description.
  it('shows a skill OpenCode 1.x also reports as a command once, as the skill', () => {
    expect(
      rows('opencode', [
        { name: 'init' },
        { name: 'release-notes', description: 'Write release notes' }
      ]).filter((row) => row.endsWith(':release-notes'))
    ).toEqual(['skill:release-notes'])
  })

  // OpenCode runs its own command before a skill of the same name, on either line.
  it.each(['opencode', 'opencode2'] as const)(
    'keeps %s’s own command when a skill shares its name, and marks the collision',
    (agent) => {
      const picked = items(
        agent,
        [{ name: 'review', description: 'review changes [commit|branch|pr]' }],
        [skill('review', 'My review checklist')]
      )
      expect(picked).toEqual([
        expect.objectContaining({ kind: 'command', name: 'review', skillCollision: true })
      ])
    }
  )

  // The chat's send runs `/compact` as compaction whichever row inserted it.
  it.each([
    ['opencode2', { name: 'compact', description: 'compact the session' }],
    ['opencode', { name: 'compact', description: 'Squash my notes' }],
    ['claude', { name: 'compact', kindUnspecified: true as const }]
  ] as const)('never lets a skill stand in for %s’s /compact', (agent, reported) => {
    const picked = items(agent, [reported], [skill('compact', 'Squash my notes')])
    expect(picked.map((item) => `${item.kind}:${item.name}`)).toEqual(['command:compact'])
    expect(isStructuredAgentSessionComposerCommand(picked[0]!.token, agent)).toBe(true)
  })
})
