// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSlashCommand } from '../../../../shared/custom-slash-commands'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'

const discovery = vi.hoisted(() => ({ commands: [] as DiscoveredSlashCommand[] }))

vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: (_agent: string, _tabId: string, enabled: boolean) => ({
    status: 'ready' as const,
    skills: [],
    commands: enabled ? discovery.commands : [],
    error: null,
    retry: () => {}
  })
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))

import { useNativeChatPickerState } from './use-native-chat-picker-state'

const CUSTOM_COMMAND: DiscoveredSlashCommand = {
  name: 'opsx:apply',
  description: 'Apply an OpenSpec change',
  scope: 'project',
  commandFilePath: '/repo/.claude/commands/opsx/apply.md'
}

function renderPicker(draft: string) {
  return renderHook(
    (props: { draft: string }) =>
      useNativeChatPickerState({
        agent: 'claude',
        terminalTabId: 'tab-1',
        draftScopeKey: 'pane-1',
        draft: props.draft,
        caret: props.draft.length,
        agentCommands: getVerifiedNativeChatCommands('claude'),
        textareaRef: createRef<HTMLTextAreaElement>(),
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      }),
    { initialProps: { draft } }
  )
}

describe('useNativeChatPickerState custom slash commands', () => {
  beforeEach(() => {
    discovery.commands = [CUSTOM_COMMAND]
  })

  it('lists .claude/commands entries beside the curated built-ins', () => {
    const { result } = renderPicker('/opsx')
    const autocomplete = result.current.autocomplete
    if (autocomplete.mode !== 'slash') {
      throw new Error('expected the slash picker to open')
    }
    expect(
      autocomplete.items.filter((item) => item.kind === 'command').map((item) => item.name)
    ).toContain('opsx:apply')
    expect(autocomplete.items.find((item) => item.name === 'opsx:apply')?.description).toBe(
      'Apply an OpenSpec change'
    )
  })

  it('keeps the built-in catalog when nothing was discovered', () => {
    discovery.commands = []
    const { result } = renderPicker('/cl')
    const autocomplete = result.current.autocomplete
    if (autocomplete.mode !== 'slash') {
      throw new Error('expected the slash picker to open')
    }
    expect(autocomplete.items.map((item) => item.name)).toContain('clear')
    expect(autocomplete.items.every((item) => item.kind === 'command')).toBe(true)
    expect(autocomplete.items.map((item) => item.name)).not.toContain('opsx:apply')
  })

  it('classifies a discovered command as a command, not an unknown token', () => {
    const { result } = renderPicker('/opsx:apply')
    expect(result.current.classifySend('/opsx:apply')).toBe('command')
  })

  it('still classifies the command once arguments close the picker', () => {
    const view = renderPicker('/opsx:apply')
    expect(view.result.current.classifySend('/opsx:apply')).toBe('command')
    // Typing a space ends the trigger token, so discovery goes idle — the
    // retained catalog is what keeps the send from reading as prose.
    view.rerender({ draft: '/opsx:apply now' })
    expect(view.result.current.classifySend('/opsx:apply now')).toBe('command')
  })

  it('leaves an unrelated slash token unknown', () => {
    const { result } = renderPicker('/nope')
    expect(result.current.classifySend('/nope')).toBe('unknown-token')
  })
})
