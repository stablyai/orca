// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSkill } from '../../../../../../shared/skills'
import { useNativeChatPickerState } from './use-native-chat-picker-state'

const skillMock = vi.hoisted((): { skills: DiscoveredSkill[] } => ({ skills: [] }))

vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({
    status: 'ready',
    skills: skillMock.skills,
    error: null,
    retry: () => {}
  })
}))

function skill(name: string): DiscoveredSkill {
  return {
    id: name,
    name,
    description: null,
    providers: ['claude'],
    sourceKind: 'repo',
    sourceLabel: 'Repository',
    rootPath: '/repo/.agents/skills',
    directoryPath: `/repo/.agents/skills/${name}`,
    skillFilePath: `/repo/.agents/skills/${name}/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

function pickerMode(draft: string, recalledFromHistory: boolean): string {
  const setDraft = vi.fn()
  const { result, rerender } = renderHook(
    (disabled: boolean) =>
      useNativeChatPickerState({
        agent: 'claude',
        terminalTabId: 'tab-1',
        draftScopeKey: 'pane-1',
        draft,
        caret: draft.length,
        agentCommands: [{ name: 'clear' }],
        recalledFromHistory,
        disabled,
        isComposing: () => false,
        textareaRef: { current: null },
        setDraft,
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      }),
    { initialProps: false }
  )
  const completeMention = result.current.completeMention
  const completeItem = result.current.completeItem
  const item =
    result.current.autocomplete.mode === 'slash' ? result.current.autocomplete.items[0] : null
  const typedMode = result.current.autocomplete.mode
  rerender(true)
  expect(result.current.autocomplete.mode).toBe('none')
  completeMention('app.ts')
  if (item) {
    completeItem(item)
  }
  expect(setDraft).not.toHaveBeenCalled()
  rerender(false)
  expect(result.current.autocomplete.mode).toBe(typedMode)
  return result.current.autocomplete.mode
}

function renderSlashPicker(draft: string, caret: number) {
  return renderHook(
    ({ draft, caret }) => {
      const [active, setActive] = useState(0)
      const picker = useNativeChatPickerState({
        agent: 'claude',
        terminalTabId: 'tab-1',
        draftScopeKey: 'pane-1',
        draft,
        caret,
        agentCommands: [{ name: 'design-consent' }, { name: 'deploy' }],
        recalledFromHistory: false,
        disabled: false,
        isComposing: () => false,
        textareaRef: { current: null },
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setActiveSuggestion: setActive
      })
      const items = picker.autocomplete.mode === 'slash' ? picker.autocomplete.items : []
      return {
        names: items.map((item) => item.name),
        active,
        setActive,
        navigate: picker.navigateSuggestion
      }
    },
    { initialProps: { draft, caret } }
  )
}

describe('useNativeChatPickerState', () => {
  afterEach(() => {
    skillMock.skills = []
  })

  it.each([
    ['open @app', 'mention'],
    ['/cl', 'slash']
  ])('opens no menu on %s while it is a message recalled from history', (draft, typedMode) => {
    expect(pickerMode(draft, false)).toBe(typedMode)
    expect(pickerMode(draft, true)).toBe('none')
  })

  it('highlights an exact skill below a fuzzy command and keeps arrow navigation', () => {
    skillMock.skills = [skill('done')]
    const { result, rerender } = renderSlashPicker('/doneX', 5)
    expect(result.current.names).toEqual(['design-consent', 'done'])
    expect(result.current.active).toBe(1)
    act(() => result.current.setActive(0))
    rerender({ draft: '/doneX', caret: 5 })
    expect(result.current.active).toBe(0)
    // Forward-deleting past the caret keeps the query but the edit handler still resets to 0.
    act(() => result.current.setActive(0))
    rerender({ draft: '/done', caret: 5 })
    expect(result.current.active).toBe(1)
  })

  it('follows late skills to the best match but keeps a row the user arrowed to', () => {
    const { result, rerender } = renderSlashPicker('/done', 5)
    expect(result.current.names).toEqual(['design-consent'])
    skillMock.skills = [skill('done')]
    rerender({ draft: '/done', caret: 5 })
    expect(result.current.active).toBe(1)

    const browsing = renderSlashPicker('/', 1)
    act(() => browsing.result.current.navigate(2))
    expect(browsing.result.current.names[2]).toBe('done')
    skillMock.skills = [skill('aaa'), skill('done')]
    browsing.rerender({ draft: '/', caret: 1 })
    expect(browsing.result.current.names).toEqual(['design-consent', 'deploy', 'aaa', 'done'])
    expect(browsing.result.current.active).toBe(3)
  })

  it('keeps a row the user arrowed back to when an exact skill loads late', () => {
    skillMock.skills = [skill('foo-bar'), skill('foo-baz')]
    const { result, rerender } = renderSlashPicker('/foo', 4)
    expect(result.current.names).toEqual(['foo-bar', 'foo-baz'])
    expect(result.current.active).toBe(0)
    act(() => result.current.navigate((index) => index + 1))
    act(() => result.current.navigate((index) => index - 1))
    skillMock.skills = [skill('foo-bar'), skill('foo-baz'), skill('foo')]
    rerender({ draft: '/foo', caret: 4 })
    expect(result.current.names[result.current.active]).toBe('foo-bar')
  })
})
