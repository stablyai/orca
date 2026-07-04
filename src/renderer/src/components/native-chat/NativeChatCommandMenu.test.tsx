// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NativeChatCommandMenu } from './NativeChatCommandMenu'
import type { SlashCommandSuggestion } from './native-chat-composer-state'
import type { DiscoveredSkill } from '../../../../shared/skills'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function command(name: string, description?: string): SlashCommandSuggestion {
  return { name, ...(description ? { description } : {}) }
}

function skill(name: string, overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: name,
    name,
    description: 'Skill description',
    providers: ['codex'],
    sourceKind: 'repo',
    sourceLabel: 'Repository',
    rootPath: '/repo/.agents/skills',
    directoryPath: `/repo/.agents/skills/${name}`,
    skillFilePath: `/repo/.agents/skills/${name}/SKILL.md`,
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

async function renderMenu(
  element: ReactElement
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return { container, root }
}

describe('NativeChatCommandMenu', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('shows a specific empty state for unmatched slash commands', async () => {
    const { container, root } = await renderMenu(
      <NativeChatCommandMenu
        autocomplete={{ mode: 'slash', query: 'zzz', suggestions: [] }}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onChooseSlash={vi.fn()}
        onAcceptMention={vi.fn()}
        onChooseSkill={vi.fn()}
      />
    )

    expect(container.textContent).toContain('No matching commands')
    act(() => root.unmount())
  })

  it('shows a specific empty state for unmatched skills', async () => {
    const { container, root } = await renderMenu(
      <NativeChatCommandMenu
        autocomplete={{ mode: 'skill', query: 'zzz', suggestions: [] }}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onChooseSlash={vi.fn()}
        onAcceptMention={vi.fn()}
        onChooseSkill={vi.fn()}
      />
    )

    expect(container.textContent).toContain('No matching skills')
    act(() => root.unmount())
  })

  it('marks the active slash row and preserves click callbacks', async () => {
    const onChooseSlash = vi.fn()
    const onActiveIndexChange = vi.fn()
    const commands = [command('clear'), command('compact', 'Compact conversation')]
    const { container, root } = await renderMenu(
      <NativeChatCommandMenu
        autocomplete={{ mode: 'slash', query: '', suggestions: commands }}
        activeIndex={1}
        onActiveIndexChange={onActiveIndexChange}
        onChooseSlash={onChooseSlash}
        onAcceptMention={vi.fn()}
        onChooseSkill={vi.fn()}
      />
    )

    const compactRow = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('/compact')
    )
    expect(container.querySelector('[role="listbox"]')).toBeTruthy()
    expect(compactRow?.getAttribute('role')).toBe('option')
    expect(compactRow?.getAttribute('aria-selected')).toBe('true')
    expect(compactRow?.getAttribute('data-active')).toBe('true')

    await act(async () => {
      compactRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      compactRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onActiveIndexChange).toHaveBeenCalledWith(1)
    expect(onChooseSlash).toHaveBeenCalledWith(commands[1])
    act(() => root.unmount())
  })

  it('renders skill rows with source labels and preserves click callbacks', async () => {
    const onChooseSkill = vi.fn()
    const onActiveIndexChange = vi.fn()
    const skills = [skill('typescript'), skill('react')]
    const { container, root } = await renderMenu(
      <NativeChatCommandMenu
        autocomplete={{ mode: 'skill', query: '', suggestions: skills }}
        activeIndex={0}
        onActiveIndexChange={onActiveIndexChange}
        onChooseSlash={vi.fn()}
        onAcceptMention={vi.fn()}
        onChooseSkill={onChooseSkill}
      />
    )

    const reactRow = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('$react')
    )
    expect(reactRow).toBeTruthy()
    expect(reactRow?.getAttribute('role')).toBe('option')
    expect(reactRow?.getAttribute('aria-selected')).toBe('false')
    expect(reactRow?.textContent).toContain('Repository')

    await act(async () => {
      reactRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      reactRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onActiveIndexChange).toHaveBeenCalledWith(1)
    expect(onChooseSkill).toHaveBeenCalledWith(skills[1])
    act(() => root.unmount())
  })

  it('scrolls the active skill into view', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })

    const { root } = await renderMenu(
      <NativeChatCommandMenu
        autocomplete={{
          mode: 'skill',
          query: '',
          suggestions: [skill('alpha'), skill('beta'), skill('gamma')]
        }}
        activeIndex={2}
        onActiveIndexChange={vi.fn()}
        onChooseSlash={vi.fn()}
        onAcceptMention={vi.fn()}
        onChooseSkill={vi.fn()}
      />
    )

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    act(() => root.unmount())
  })

  it('scrolls the active slash command into view', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })

    const { root } = await renderMenu(
      <NativeChatCommandMenu
        autocomplete={{
          mode: 'slash',
          query: '',
          suggestions: [command('clear'), command('compact'), command('help')]
        }}
        activeIndex={2}
        onActiveIndexChange={vi.fn()}
        onChooseSlash={vi.fn()}
        onAcceptMention={vi.fn()}
        onChooseSkill={vi.fn()}
      />
    )

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    act(() => root.unmount())
  })

  it('renders mention as one action row without a false result list', async () => {
    const onAcceptMention = vi.fn()
    const { container, root } = await renderMenu(
      <NativeChatCommandMenu
        autocomplete={{ mode: 'mention', query: 'src/App.tsx' }}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onChooseSlash={vi.fn()}
        onAcceptMention={onAcceptMention}
        onChooseSkill={vi.fn()}
      />
    )

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toContain('@src/App.tsx')

    await act(async () => {
      buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onAcceptMention).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
  })
})
