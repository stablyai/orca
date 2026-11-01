// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

import { ChatBehaviorSetting } from './ChatBehaviorSetting'
import { i18n } from '@/i18n/i18n'
import de from '../../i18n/locales/de.json'
import { TooltipProvider } from '../ui/tooltip'

afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
  vi.unstubAllGlobals()
})

const NAME_INPUT = '#settings-native-chat-shell-environment-name'

function renderSetting(overrides: Partial<GlobalSettings>, updateSettings = vi.fn()) {
  return render(
    <ChatBehaviorSetting
      settings={{ ...getDefaultSettings('/tmp'), ...overrides }}
      updateSettings={updateSettings}
    />,
    { wrapper: TooltipProvider }
  )
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

describe('ChatBehaviorSetting shell environment', () => {
  const chooseNames = { nativeChatInheritShellEnvironment: false }

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
      <ChatBehaviorSetting
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

describe('ChatBehaviorSetting follow-up behavior', () => {
  const FOLLOW_UP_SWITCH = '[role="switch"][aria-label="Queue follow-ups"]'

  it('hides the choice until the host answers, then shows it', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    let answer: (status: { capabilities: string[] }) => void = () => {}
    vi.stubGlobal('api', {
      runtime: { getStatus: () => new Promise((resolve) => (answer = resolve)) }
    })
    const { container } = renderSetting({})
    expect(container.querySelector(FOLLOW_UP_SWITCH)).toBeNull()
    await act(async () =>
      answer({ capabilities: [AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY] })
    )
    expect(container.querySelector(FOLLOW_UP_SWITCH)).not.toBeNull()
  })

  it.each([true, false, undefined])(
    'reads Queue by default and toggles the existing boolean (%s)',
    (saved) => {
      setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
      const updateSettings = vi.fn()
      const { container } = renderSetting({ nativeChatQueueFollowUps: saved }, updateSettings)
      const toggle = container.querySelector<HTMLButtonElement>(FOLLOW_UP_SWITCH)!
      expect(toggle.getAttribute('aria-checked')).toBe(String(saved !== false))
      // The alternate is described relative to the switch, so the copy holds on and off.
      expect(container.textContent).toContain('Cmd/Ctrl+Enter does the opposite for one message.')
      fireEvent.click(toggle)
      expect(updateSettings).toHaveBeenCalledWith({ nativeChatQueueFollowUps: saved === false })
    }
  )
})

it('renders the Queue switch and description using the German catalog', async () => {
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
  i18n.addResourceBundle('de', 'translation', de, true, true)
  await act(async () => {
    await i18n.changeLanguage('de')
  })
  try {
    const { container } = renderSetting({})
    const copy = de.components.settings.nativeChat
    expect(
      container
        .querySelector(`[role="switch"][aria-label="${copy.followUpBehaviorTitle}"]`)
        ?.getAttribute('aria-checked')
    ).toBe('true')
    expect(container.textContent).toContain(copy.followUpBehaviorTitle)
    expect(container.textContent).toContain(copy.followUpBehaviorCopy)
    expect(copy.followUpBehaviorCopy).toContain(
      'Cmd/Strg+Enter macht für eine Nachricht das Gegenteil.'
    )
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  }
})
