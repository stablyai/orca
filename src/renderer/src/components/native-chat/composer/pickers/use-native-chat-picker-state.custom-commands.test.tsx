// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSlashCommand } from '../../../../../../shared/custom-slash-commands'
import { getVerifiedNativeChatCommands } from '../../../../../../shared/native-chat/native-chat-agent-profiles'

const discovery = vi.hoisted(() => {
  const commandsByTab: Record<string, DiscoveredSlashCommand[]> = {}
  return { commandsByTab }
})

vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: (_agent: string, tabId: string, enabled: boolean) => ({
    status: 'ready' as const,
    skills: [],
    commands: enabled ? (discovery.commandsByTab[tabId] ?? []) : [],
    error: null,
    retry: () => {}
  })
}))

import { useNativeChatPickerState } from './use-native-chat-picker-state'

const CUSTOM_COMMAND: DiscoveredSlashCommand = {
  name: 'opsx:apply',
  description: 'Apply an OpenSpec change',
  scope: 'project',
  commandFilePath: '/repo/.claude/commands/opsx/apply.md'
}

function renderPicker(draft: string, terminalTabId = 'tab-1') {
  return renderHook(
    (props: { draft: string; terminalTabId: string }) =>
      useNativeChatPickerState({
        agent: 'claude',
        terminalTabId: props.terminalTabId,
        draftScopeKey: 'pane-1',
        draft: props.draft,
        caret: props.draft.length,
        agentCommands: getVerifiedNativeChatCommands('claude'),
        recalledFromHistory: false,
        disabled: false,
        isComposing: () => false,
        textareaRef: { current: null },
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      }),
    { initialProps: { draft, terminalTabId } }
  )
}

describe('useNativeChatPickerState custom slash commands', () => {
  beforeEach(() => {
    discovery.commandsByTab = { 'tab-1': [CUSTOM_COMMAND] }
  })

  it('lists .claude/commands entries beside the curated built-ins', () => {
    const { result } = renderPicker('/opsx')
    const autocomplete = result.current.autocomplete
    if (autocomplete.mode !== 'slash') {
      throw new Error('expected the slash picker to open')
    }
    expect(autocomplete.items.find((item) => item.name === 'opsx:apply')).toMatchObject({
      kind: 'command',
      description: 'Apply an OpenSpec change'
    })
  })

  it('still classifies the command once arguments close the picker', () => {
    const view = renderPicker('/opsx:apply')
    expect(view.result.current.classifySend('/opsx:apply')).toBe('command')
    view.rerender({ draft: '/opsx:apply now', terminalTabId: 'tab-1' })
    expect(view.result.current.classifySend('/opsx:apply now')).toBe('command')
  })

  it('does not classify the previous tab command after a tab switch', () => {
    const view = renderPicker('/opsx:apply')
    expect(view.result.current.classifySend('/opsx:apply')).toBe('command')
    view.rerender({ draft: '/opsx:apply now', terminalTabId: 'tab-2' })
    expect(view.result.current.classifySend('/opsx:apply now')).toBe('unknown-token')
  })

  it('leaves an unrelated slash token unknown', () => {
    const { result } = renderPicker('/nope')
    expect(result.current.classifySend('/nope')).toBe('unknown-token')
  })
})
