// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildNativeChatPickerItems } from './native-chat-picker-items'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { EMPTY_HISTORY } from './native-chat-composer-state'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'

function transport(sessionCommands?: NativeChatStructuredComposerTransport['sessionCommands']) {
  return { sessionCommands } as NativeChatStructuredComposerTransport
}

describe('composer catalog authority', () => {
  it('keeps PTY and unsupported structured providers on their original catalogs', () => {
    const pty = renderHook(() => useNativeChatComposerCatalog('claude'))
    expect(pty.result.current.agentCommands).toEqual(getVerifiedNativeChatCommands('claude'))
    expect(pty.result.current.sessionSkillNames).toBeUndefined()
    const oldHost = renderHook(() => useNativeChatComposerCatalog('claude', transport()))
    expect(oldHost.result.current.agentCommands).toEqual(structuredSlashCommands())
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
      'compact'
    ])
    rerender({ conversationCommands: ['clear'] })
    expect(result.current.agentCommands.map(({ name }) => name)).toEqual([
      'model',
      'effort',
      'clear'
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
    expect(result.current).toEqual({ agentCommands: [], sessionSkillNames: [] })
    rerender({ reported: [{ name: 'custom-command', kind: 'command' }] })
    expect(result.current).toEqual({
      agentCommands: [{ name: 'custom-command' }],
      sessionSkillNames: []
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
          grouped: true,
          commandsEnabled: true,
          skillsEnabled: true,
          skillStatus: 'ready'
        },
        activeSuggestion,
        draft: '/',
        history: EMPTY_HISTORY,
        isComposing: () => false,
        completePickerItem: complete,
        dispatchPickerCommand: dispatch,
        dismissPicker: vi.fn(),
        interrupt: vi.fn(),
        send: vi.fn(),
        setActiveSuggestion: vi.fn(),
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setHistory: vi.fn()
      })
    },
    { initialProps: { activeSuggestion: 1 } }
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
