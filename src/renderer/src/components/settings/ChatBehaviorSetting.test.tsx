// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

// Why: Radix Select needs pointer/layout APIs happy-dom lacks; a native select keeps value testable.
vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      aria-label="While the agent works, Enter"
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

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
  const FOLLOW_UP_SELECT = 'select[aria-label="While the agent works, Enter"]'

  it('hides the choice until the host answers, then shows it', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    let answer: (status: { capabilities: string[] }) => void = () => {}
    vi.stubGlobal('api', {
      runtime: { getStatus: () => new Promise((resolve) => (answer = resolve)) }
    })
    const { container } = renderSetting({})
    expect(container.querySelector(FOLLOW_UP_SELECT)).toBeNull()
    await act(async () =>
      answer({ capabilities: [AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY] })
    )
    expect(container.querySelector(FOLLOW_UP_SELECT)).not.toBeNull()
  })

  it('reads Steer by default and saves Queue through the follow-up key', () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
    const updateSettings = vi.fn()
    const { container } = renderSetting({}, updateSettings)
    const select = container.querySelector<HTMLSelectElement>(FOLLOW_UP_SELECT)!
    expect(select.value).toBe('steer')
    fireEvent.change(select, { target: { value: 'queue' } })
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatFollowUpBehavior: 'queue' })
  })
})

it('renders the follow-up Select and its options using the German catalog', async () => {
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
  i18n.addResourceBundle('de', 'translation', de, true, true)
  await act(async () => {
    await i18n.changeLanguage('de')
  })
  try {
    const { container } = renderSetting({ experimentalNativeChat: true })
    const options = Array.from(container.querySelectorAll('select option')).map(
      (option) => option.textContent
    )
    expect(options).toContain(de.components.settings.nativeChat.followUpSteer)
    expect(options).toContain(de.components.settings.nativeChat.followUpQueue)
    expect(container.textContent).toContain(de.components.settings.nativeChat.followUpBehaviorTitle)
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  }
})
