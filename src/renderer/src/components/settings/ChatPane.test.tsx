// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppStore } from '../../store'
import { ChatPane } from './ChatPane'

vi.mock('../ui/select', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({})

  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const contextValue = React.useMemo(() => ({ onValueChange }), [onValueChange])
      return (
        <SelectContext.Provider value={contextValue}>
          <div data-slot="native-chat-default-view-select" data-value={value}>
            {children}
          </div>
        </SelectContext.Provider>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'> & { size?: string }) => (
      <button type="button" data-slot="select-trigger" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="select-content">{children}</div>
    ),
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = React.useContext(SelectContext)
      return (
        <button
          type="button"
          data-slot="select-item"
          data-value={value}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ settingsSearchQuery: '' })
  vi.unstubAllGlobals()
})

const CHAT_UI_TOGGLE = '#chat-ui button[role="switch"]'
const RESUME_TOGGLE = '[aria-label="Toggle automatic resume after a restart"]'
const SHELL_ENV_TOGGLE = '[aria-label="Toggle using your shell environment"]'
const NAME_INPUT = '#settings-native-chat-shell-environment-name'
const DEFAULT_VIEW_SELECT = '[data-slot="native-chat-default-view-select"]'
const STRUCTURED_SCOPE =
  'Local sessions only for now. WSL and remote execution hosts (including SSH) continue to use terminal chat.'

function renderSetting(overrides: Partial<GlobalSettings>, updateSettings = vi.fn()) {
  return render(
    <ChatPane
      settings={{ ...getDefaultSettings('/tmp'), ...overrides }}
      updateSettings={updateSettings}
    />
  )
}

function defaultViewOption(container: HTMLElement, value: string): HTMLButtonElement {
  const option = container.querySelector<HTMLButtonElement>(
    `[data-slot="select-item"][data-value="${value}"]`
  )
  if (!option) {
    throw new Error(`Default-view option ${value} was not rendered`)
  }
  return option
}

function nameInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(NAME_INPUT)!
}

function addButton(container: HTMLElement): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Add'
  )!
}

function removeButton(container: HTMLElement, name: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name}"]`)
}

function listedNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('li')).map((item) => item.title)
}

describe('ChatPane shell environment', () => {
  it('shows whenever Chat UI is on, whatever the default view', () => {
    for (const experimentalNativeChat of [false, true]) {
      for (const openAgentTabsInChatByDefault of [false, true]) {
        const { container, unmount } = renderSetting({
          experimentalNativeChat,
          openAgentTabsInChatByDefault
        })
        const expected = experimentalNativeChat
        const label = JSON.stringify({ experimentalNativeChat, openAgentTabsInChatByDefault })
        expect(container.querySelector(SHELL_ENV_TOGGLE) !== null, label).toBe(expected)
        expect(container.querySelector(RESUME_TOGGLE) !== null, label).toBe(expected)
        unmount()
      }
    }
  })

  const structuredOn = {
    experimentalNativeChat: true,
    openAgentTabsInChatByDefault: true
  }
  const chooseNames = { ...structuredOn, nativeChatInheritShellEnvironment: false }

  it('hides the variable list while the whole shell is inherited', () => {
    const { container } = renderSetting(structuredOn)
    expect(container.querySelector(NAME_INPUT)).toBeNull()
  })

  it('turns inheritance off from the toggle', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(structuredOn, updateSettings)
    fireEvent.click(container.querySelector(SHELL_ENV_TOGGLE)!)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatInheritShellEnvironment: false })
  })

  it('lists the saved names in saved order, or an empty line when there are none', () => {
    const { container, rerender } = renderSetting(chooseNames)
    expect(listedNames(container)).toEqual([])
    expect(container.textContent).toContain('No variables added yet.')

    rerender(
      <ChatPane
        settings={{
          ...getDefaultSettings('/tmp'),
          ...chooseNames,
          nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 'CODEX_LB_API_KEY']
        }}
        updateSettings={vi.fn()}
      />
    )
    expect(listedNames(container)).toEqual(['HTTPS_PROXY', 'CODEX_LB_API_KEY'])
    expect(container.textContent).not.toContain('No variables added yet.')
  })

  it('adds a typed name from the Add button, clears the input, and keeps focus there', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(
      { ...chooseNames, nativeChatShellEnvironmentVariables: ['HTTPS_PROXY'] },
      updateSettings
    )
    const input = nameInput(container)
    expect(addButton(container).disabled).toBe(true)

    fireEvent.change(input, { target: { value: ' CODEX_LB_API_KEY ' } })
    expect(addButton(container).disabled).toBe(false)
    fireEvent.click(addButton(container))

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({
      nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 'CODEX_LB_API_KEY']
    })
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })

  it('adds a typed name on Enter', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(chooseNames, updateSettings)
    const input = nameInput(container)

    fireEvent.change(input, { target: { value: 'HTTPS_PROXY' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateSettings).toHaveBeenCalledWith({
      nativeChatShellEnvironmentVariables: ['HTTPS_PROXY']
    })
    expect(input.value).toBe('')
  })

  it('refuses a name a shell would not accept', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(chooseNames, updateSettings)
    const input = nameInput(container)

    fireEvent.change(input, { target: { value: 'FOO-BAR' } })
    expect(addButton(container).disabled).toBe(true)
    fireEvent.click(addButton(container))
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateSettings).not.toHaveBeenCalled()
    expect(input.value).toBe('FOO-BAR')
  })

  it('does not append a name that is already listed', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(
      { ...chooseNames, nativeChatShellEnvironmentVariables: ['HTTPS_PROXY'] },
      updateSettings
    )
    const input = nameInput(container)

    fireEvent.change(input, { target: { value: 'HTTPS_PROXY' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateSettings).not.toHaveBeenCalled()
    expect(input.value).toBe('')
  })

  it('removes one entry from its chip and moves focus to the input', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(
      {
        ...chooseNames,
        nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 'CODEX_LB_API_KEY', 'NO_PROXY']
      },
      updateSettings
    )

    fireEvent.click(removeButton(container, 'CODEX_LB_API_KEY')!)

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({
      nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 'NO_PROXY']
    })
    expect(document.activeElement).toBe(nameInput(container))
  })

  it('keeps a half-typed name across an unrelated settings re-render', () => {
    const { container, rerender } = renderSetting(chooseNames)
    fireEvent.change(nameInput(container), { target: { value: 'HTTPS_PRO' } })

    rerender(
      <ChatPane
        settings={{
          ...getDefaultSettings('/tmp'),
          ...chooseNames,
          nativeChatResumeWorkOnRestart: true
        }}
        updateSettings={vi.fn()}
      />
    )

    expect(nameInput(container).value).toBe('HTTPS_PRO')
  })
})

describe('ChatPane', () => {
  it('renders Chat UI off by default with no child rows', () => {
    const settings = getDefaultSettings('/tmp')
    const { container } = renderSetting({})

    expect(settings.experimentalNativeChat).toBe(false)
    expect(container.querySelector(CHAT_UI_TOGGLE)?.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('Chat UI')
    expect(container.textContent).not.toContain('Default view')
    expect(container.textContent).not.toMatch(/experimental|preview/i)
  })

  it('writes only the Chat UI key from its switch', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting({}, updateSettings)

    fireEvent.click(container.querySelector(CHAT_UI_TOGGLE)!)

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ experimentalNativeChat: true })
  })

  it('shows the default view as a child row only when Chat UI is enabled', async () => {
    const updateSettings = vi.fn()
    const settings = { experimentalNativeChat: true, openAgentTabsInChatByDefault: false }
    const { container, rerender } = renderSetting(settings, updateSettings)

    expect(container.querySelector('#chat-default-view')).not.toBeNull()
    expect(container.textContent).toContain('Terminal chat')
    expect(container.querySelector(DEFAULT_VIEW_SELECT)?.getAttribute('data-value')).toBe(
      'terminal-chat'
    )
    expect(container.textContent).not.toContain(STRUCTURED_SCOPE)

    await act(async () => {
      defaultViewOption(container, 'native-chat').click()
    })
    expect(updateSettings).toHaveBeenCalledWith({ openAgentTabsInChatByDefault: true })

    rerender(
      <ChatPane
        settings={{
          ...getDefaultSettings('/tmp'),
          ...settings,
          openAgentTabsInChatByDefault: true
        }}
        updateSettings={updateSettings}
      />
    )
    expect(container.querySelector(DEFAULT_VIEW_SELECT)?.getAttribute('data-value')).toBe(
      'native-chat'
    )
    expect(container.textContent).toContain(STRUCTURED_SCOPE)

    await act(async () => {
      defaultViewOption(container, 'terminal-chat').click()
    })
    expect(updateSettings).toHaveBeenCalledWith({ openAgentTabsInChatByDefault: false })
    expect(updateSettings).toHaveBeenCalledTimes(2)
  })

  it('offers no structured-runtime opt-in', () => {
    const { container } = renderSetting({
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    })

    expect(container.textContent).not.toContain('Use updated structured native chat')
    expect(container.querySelectorAll('button[role="switch"]')).toHaveLength(3)
  })

  it('writes only the resume key from its switch', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(
      { experimentalNativeChat: true, openAgentTabsInChatByDefault: true },
      updateSettings
    )

    fireEvent.click(container.querySelector(RESUME_TOGGLE)!)

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatResumeWorkOnRestart: true })
  })

  it('hides the host-owned resume and shell rows on a paired web client', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const { container } = renderSetting({
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    })

    expect(container.querySelector(CHAT_UI_TOGGLE)).not.toBeNull()
    expect(container.querySelector('#chat-default-view')).not.toBeNull()
    expect(container.querySelector(RESUME_TOGGLE)).toBeNull()
    expect(container.querySelector(SHELL_ENV_TOGGLE)).toBeNull()
  })

  it('keeps the Chat UI switch reachable when a search matches only a host-owned row', () => {
    useAppStore.setState({ settingsSearchQuery: 'variables' })
    const { container } = renderSetting({
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    })

    expect(container.querySelector(CHAT_UI_TOGGLE)).not.toBeNull()
    expect(container.querySelector('#chat-default-view')).toBeNull()
    expect(container.querySelector('#chat-shell-environment')).not.toBeNull()
    expect(container.querySelector('#chat-resume-on-restart')).toBeNull()
  })

  it('finds the resume row under Terminal chat', () => {
    useAppStore.setState({ settingsSearchQuery: 'resume' })
    const { container } = renderSetting({
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: false
    })

    expect(container.querySelector('#chat-resume-on-restart')).not.toBeNull()
  })

  it('hides the default view when a search matches neither it nor a structured row', () => {
    useAppStore.setState({ settingsSearchQuery: 'grok' })
    const { container } = renderSetting({
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    })

    expect(container.querySelector(CHAT_UI_TOGGLE)).not.toBeNull()
    expect(container.querySelector('#chat-default-view')).toBeNull()
  })
})
