// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildNativeChatPickerItems } from './native-chat-picker-items'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { sessionSlashCommandSuggestions } from '../../../../shared/native-chat-slash-commands'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'
import { withNativeChatResumeCommand } from './use-native-chat-resume-command'

function transport(sessionCommands?: NativeChatStructuredComposerTransport['sessionCommands']) {
  return { sessionCommands } as NativeChatStructuredComposerTransport
}

describe('composer catalog authority', () => {
  it('keeps PTY and unsupported structured providers on their original catalogs', () => {
    const pty = renderHook(() => useNativeChatComposerCatalog('claude'))
    expect(pty.result.current.agentCommands).toEqual(getVerifiedNativeChatCommands('claude'))
    expect(pty.result.current.sessionSkillNames).toBeUndefined()
    const oldHost = renderHook(() => useNativeChatComposerCatalog('claude', transport()))
    expect(oldHost.result.current.agentCommands).toEqual(
      withNativeChatResumeCommand(structuredSlashCommands())
    )
    expect(oldHost.result.current.sessionSkillNames).toBeUndefined()
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
  it('leaves the Claude route on its own commands, reported or not', () => {
    const reported = [{ name: 'init', kind: 'command' as const }]
    const withReport = renderHook(() => useNativeChatComposerCatalog('claude', transport(reported)))
    expect(withReport.result.current.agentCommands).toEqual(
      withNativeChatResumeCommand(sessionSlashCommandSuggestions('claude', reported))
    )
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
      agentCommands: withNativeChatResumeCommand([]),
      sessionSkillNames: []
    })
    rerender({ reported: [{ name: 'custom-command', kind: 'command' }] })
    expect(result.current).toEqual({
      agentCommands: withNativeChatResumeCommand([{ name: 'custom-command' }]),
      sessionSkillNames: []
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
      buildNativeChatPickerItems(catalog.agentCommands, [], query, '/', catalog.sessionSkillNames)
    expect(rows('').map(({ kind, name }) => `${kind}:${name}`)).toEqual([
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
        catalog.sessionSkillNames
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
    // Commands lead: clear, then Orca's /resume, then the skill.
    { initialProps: { activeSuggestion: 2 } }
  )
  const enter = { key: 'Enter', nativeEvent: {}, preventDefault: vi.fn() } as unknown as Parameters<
    typeof result.current
  >[0]
  result.current(enter)
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'project-skill', kind: 'skill' })
  )
  expect(dispatch).not.toHaveBeenCalled()
  rerender({ activeSuggestion: 0 })
  result.current(enter)
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'clear', kind: 'command' }))
})
