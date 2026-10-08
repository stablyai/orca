// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppStore } from '../../store'
import { ChatUiSetting } from './ChatUiSetting'
import {
  chatUiRowsIndexedIn,
  getChatUiSearchEntries,
  type ChatSettingRowId,
  type ChatUiRowConditions
} from './chat-search'

afterEach(() => {
  cleanup()
  useAppStore.setState({ settingsSearchQuery: '' })
})

const CHAT_UI_TOGGLE = '#chat-ui button[role="switch"]'
const QUEUE_TOGGLE = '[aria-label="Toggle queue follow-ups"]'
const RESUME_TOGGLE = '[aria-label="Toggle automatic resume after a restart"]'
const SHELL_ENV_TOGGLE = '[aria-label="Toggle using your shell environment"]'
const NAME_INPUT = '#settings-native-chat-shell-environment-name'

// Desktop with chats in use on a host that does not queue follow-ups, as shipped builds are.
function indexedRows(conditions: Partial<ChatUiRowConditions> = {}): ReadonlySet<ChatSettingRowId> {
  return chatUiRowsIndexedIn(
    getChatUiSearchEntries({
      isWebClient: false,
      structuredChatsInUse: true,
      hostQueuesChatMessages: false,
      ...conditions
    })
  )
}

function renderSetting(
  overrides: Partial<GlobalSettings>,
  updateSettings = vi.fn(),
  rows = indexedRows()
) {
  return render(
    <ChatUiSetting
      settings={{ ...getDefaultSettings('/tmp'), ...overrides }}
      updateSettings={updateSettings}
      rows={rows}
    />
  )
}

describe('Chat UI nested rows', () => {
  it('renders only the Chat UI switch while no chats are in use on this machine', () => {
    const { container } = renderSetting(
      { experimentalNativeChat: false },
      vi.fn(),
      indexedRows({ structuredChatsInUse: false })
    )
    expect(container.querySelector(CHAT_UI_TOGGLE)).not.toBeNull()
    expect(container.querySelectorAll('button[role="switch"]')).toHaveLength(1)
    expect(container.querySelector('.border-l')).toBeNull()
  })

  it('shows the host options with Chat UI off when the index lists them', () => {
    const { container } = renderSetting({ experimentalNativeChat: false })
    expect(container.querySelector(RESUME_TOGGLE)).not.toBeNull()
    expect(container.querySelector(SHELL_ENV_TOGGLE)).not.toBeNull()
  })

  it('shows queue follow-ups when this machine queues follow-ups', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(
      { experimentalNativeChat: true },
      updateSettings,
      indexedRows({ hostQueuesChatMessages: true })
    )
    expect(container.textContent).toContain('Messages with images send right away.')
    fireEvent.click(container.querySelector(QUEUE_TOGGLE)!)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatQueueFollowUps: false })
  })

  it('leaves no queue follow-ups wrapper when this machine cannot queue follow-ups', () => {
    const { container } = renderSetting({ experimentalNativeChat: true })
    expect(container.querySelector(QUEUE_TOGGLE)).toBeNull()
    expect(container.querySelector('#chat-queue-follow-ups')).toBeNull()
    const nested = container.querySelector('.border-l')
    expect(nested?.firstElementChild?.id).toBe('chat-resume-on-restart')
  })
})

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

describe('ChatUiSetting shell environment', () => {
  const structuredOn = {
    experimentalNativeChat: true
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
      <ChatUiSetting
        settings={{
          ...getDefaultSettings('/tmp'),
          ...chooseNames,
          nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 'CODEX_LB_API_KEY']
        }}
        updateSettings={vi.fn()}
        rows={indexedRows()}
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
      <ChatUiSetting
        settings={{
          ...getDefaultSettings('/tmp'),
          ...chooseNames,
          nativeChatResumeWorkOnRestart: true
        }}
        updateSettings={vi.fn()}
        rows={indexedRows()}
      />
    )

    expect(nameInput(container).value).toBe('HTTPS_PRO')
  })
})

describe('ChatUiSetting', () => {
  it('renders Chat UI off by default with no child rows', () => {
    const settings = getDefaultSettings('/tmp')
    const { container } = renderSetting({}, vi.fn(), indexedRows({ structuredChatsInUse: false }))

    expect(settings.experimentalNativeChat).toBe(false)
    expect(container.querySelector(CHAT_UI_TOGGLE)?.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('Chat UI')
    expect(container.textContent).toContain('New supported agents open in chat.')
    expect(container.textContent).toContain('existing chats stay available.')
    expect(container.textContent).not.toContain('Supported agents:')
    expect(container.textContent).not.toContain('Default view')
    expect(container.textContent).not.toMatch(/experimental|preview/i)
    expect(container.querySelector('.border-l')).toBeNull()
  })

  it('writes only the Chat UI key from its switch', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting({}, updateSettings)

    fireEvent.click(container.querySelector(CHAT_UI_TOGGLE)!)

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ experimentalNativeChat: true })
  })

  it('offers no structured-runtime opt-in', () => {
    const { container } = renderSetting({ experimentalNativeChat: true })

    expect(container.textContent).not.toContain('Use updated structured native chat')
    expect(container.querySelectorAll('button[role="switch"]')).toHaveLength(3)
  })

  it('writes only the resume key from its switch', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting({ experimentalNativeChat: true }, updateSettings)

    fireEvent.click(container.querySelector(RESUME_TOGGLE)!)

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatResumeWorkOnRestart: true })
  })

  it('keeps the Chat UI switch reachable when a search matches only a host-owned row', () => {
    useAppStore.setState({ settingsSearchQuery: 'variables' })
    const { container } = renderSetting({ experimentalNativeChat: true })

    expect(container.querySelector(CHAT_UI_TOGGLE)).not.toBeNull()
    expect(container.querySelector('#chat-shell-environment')).not.toBeNull()
    expect(container.querySelector('#chat-resume-on-restart')).toBeNull()
  })

  it('finds the resume row when Chat UI is on', () => {
    useAppStore.setState({ settingsSearchQuery: 'resume' })
    const { container } = renderSetting({ experimentalNativeChat: true })

    expect(container.querySelector('#chat-resume-on-restart')).not.toBeNull()
  })

  it('keeps the Chat UI switch on unrelated searches', () => {
    useAppStore.setState({ settingsSearchQuery: 'theme' })
    const { container } = renderSetting({ experimentalNativeChat: true })

    expect(container.querySelector(CHAT_UI_TOGGLE)).not.toBeNull()
  })
})

describe('ChatUiSetting inline visuals', () => {
  it('leaves Inline visuals on the Chat page even while structured chat is enabled', () => {
    const { queryByRole, getByRole } = renderSetting({
      experimentalNativeChat: true
    })
    expect(getByRole('switch', { name: 'Toggle automatic resume after a restart' })).toBeTruthy()
    expect(queryByRole('switch', { name: 'Toggle inline visuals' })).toBeNull()
  })
})
