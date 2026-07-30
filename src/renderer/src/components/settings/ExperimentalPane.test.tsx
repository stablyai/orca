// @vitest-environment happy-dom

import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/constants'
import { ExperimentalPane } from './ExperimentalPane'
import { getExperimentalPaneSearchEntries, getExperimentalSearchEntry } from './experimental-search'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('./EphemeralVmsPane', () => ({
  EphemeralVmsPane: () => <div data-testid="ephemeral-vms-pane">Cloud VM pane</div>
}))

vi.mock('../ui/select', async () => {
  const React = await import('react')

  const SelectContext = React.createContext<{
    onValueChange?: (value: string) => void
  }>({})

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
  document.body.innerHTML = ''
})

function setInputValue(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderExperimentalPane(args: {
  updateSettings: (settings: Partial<GlobalSettings>) => void
  settings?: GlobalSettings
}): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ExperimentalPane
        settings={args.settings ?? getDefaultSettings('/tmp')}
        updateSettings={args.updateSettings}
      />
    )
  })
  return { root, container }
}

describe('ExperimentalPane', () => {
  it('does not render compact worktree cards after graduation from Experimental', () => {
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(markup).not.toContain('Compact worktree cards')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).not.toContain(
      'Compact worktree cards'
    )
  })

  it('renders agent sleep as an off-by-default searchable experimental switch', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} />
    )

    expect(settings.experimentalAgentHibernation).toBe(false)
    expect(settings.agentHibernationIdleMs).toBe(30 * 60 * 1000)
    expect(markup).toContain('Agent sleep')
    expect(markup).toContain('Manually started agents may resume')
    expect(markup).not.toContain('Sleep after')
    expect(markup).toContain('aria-checked="false"')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).toContain('Agent sleep')
  })

  it('renders new card style as an off-by-default searchable experimental switch', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} />
    )

    expect(settings.experimentalNewWorktreeCardStyle).toBe(false)
    expect(markup).toContain('New card style')
    expect(markup).toContain('aria-checked="false"')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).toContain(
      'New card style'
    )
  })

  it('renders the agent dashboard as an off-by-default searchable experiment', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} />
    )

    expect(settings.experimentalAgentDashboardPopout).toBe(false)
    expect(markup).toContain('Agent Dashboard')
    expect(markup).toContain('Monitor agents that need you, are working, or are done')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).toContain(
      'Agent Dashboard'
    )
  })

  it('enables the agent dashboard through its experimental switch', async () => {
    const updateSettings = vi.fn()
    const { root, container } = await renderExperimentalPane({ updateSettings })
    const switchButton = container.querySelector<HTMLButtonElement>(
      '#experimental-agent-dashboard button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('Agent Dashboard switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalAgentDashboardPopout: true })
    root.unmount()
  })

  it('exposes idle-agent visibility for pop-out dashboards', async () => {
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalAgentDashboardPopout: true
    }
    const { root, container } = await renderExperimentalPane({
      settings,
      updateSettings
    })
    const idleSwitch = container.querySelector<HTMLButtonElement>(
      '#experimental-agent-dashboard button[role="switch"][aria-label="Show idle agents"]'
    )
    if (!idleSwitch) {
      throw new Error('Idle-agent visibility switch was not rendered')
    }

    await act(async () => {
      idleSwitch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalAgentDashboardShowIdle: true })
    root.unmount()
  })

  it('renders Cloud VM as an off-by-default experimental subsection', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} />
    )
    const entry = getExperimentalPaneSearchEntries().find(
      (searchEntry) => searchEntry.title === 'Cloud VM'
    )

    expect(settings.experimentalEphemeralVms).toBe(false)
    expect(markup).toContain('Cloud VM')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).not.toContain('Cloud VM pane')
    expect(entry?.targetSectionId).toBe('ephemeral-vms')
  })

  it('enables Cloud VM through the experimental switch', async () => {
    const updateSettings = vi.fn()
    const { root, container } = await renderExperimentalPane({ updateSettings })

    const switchButton = container.querySelector<HTMLButtonElement>(
      '#ephemeral-vms button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('Cloud VM switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalEphemeralVms: true })
    root.unmount()
  })

  it('shows Cloud VM setup controls when enabled', () => {
    const markup = renderToStaticMarkup(
      <ExperimentalPane
        settings={{ ...getDefaultSettings('/tmp'), experimentalEphemeralVms: true }}
        updateSettings={vi.fn()}
      />
    )

    expect(markup).toContain('Cloud VM pane')
    expect(markup).toContain('aria-checked="true"')
  })

  it('shows Chat UI default-mode as a child setting only when Chat UI is enabled', async () => {
    const updateSettings = vi.fn()
    const disabledSettings = getDefaultSettings('/tmp')
    const disabledMarkup = renderToStaticMarkup(
      <ExperimentalPane settings={disabledSettings} updateSettings={vi.fn()} />
    )
    expect(disabledMarkup).toContain('Chat UI')
    expect(disabledMarkup).not.toContain('Default view')

    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: false
    }
    const { root, container } = await renderExperimentalPane({ updateSettings, settings })

    expect(container.textContent).toContain('Default view')
    expect(container.textContent).toContain('Terminal chat')
    expect(container.textContent).toContain('Chat UI')
    expect(
      container
        .querySelector('[data-slot="native-chat-default-view-select"]')
        ?.getAttribute('data-value')
    ).toBe('terminal-chat')

    const nativeChatOption = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-slot="select-item"]')
    ).find((button) => button.getAttribute('data-value') === 'native-chat')
    if (!nativeChatOption) {
      throw new Error('Chat UI default-view option was not rendered')
    }

    await act(async () => {
      nativeChatOption.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ openAgentTabsInChatByDefault: true })

    root.unmount()

    const nativeSettings = {
      ...settings,
      openAgentTabsInChatByDefault: true
    }
    const secondRender = await renderExperimentalPane({
      updateSettings,
      settings: nativeSettings
    })

    expect(
      secondRender.container
        .querySelector('[data-slot="native-chat-default-view-select"]')
        ?.getAttribute('data-value')
    ).toBe('native-chat')

    const terminalChatOption = Array.from(
      secondRender.container.querySelectorAll<HTMLButtonElement>('[data-slot="select-item"]')
    ).find((button) => button.getAttribute('data-value') === 'terminal-chat')
    if (!terminalChatOption) {
      throw new Error('Terminal chat default-view option was not rendered')
    }

    await act(async () => {
      terminalChatOption.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ openAgentTabsInChatByDefault: false })

    secondRender.root.unmount()
  })

  it('renders the agent sleep idle duration as configurable minutes', async () => {
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalAgentHibernation: true
    }
    const { root, container } = await renderExperimentalPane({ updateSettings, settings })

    const idleInput = container.querySelector<HTMLInputElement>(
      '#experimental-agent-hibernation input[type="number"]'
    )
    if (!idleInput) {
      throw new Error('Agent sleep duration input was not rendered')
    }

    expect(idleInput.value).toBe('30')
    expect(idleInput.min).toBe('1')
    expect(idleInput.max).toBe('1440')
    expect(idleInput.step).toBe('1')
    expect(container.textContent).toContain('How many idle minutes')
    expect(container.textContent).toContain('minutes')
    root.unmount()
  })

  it('enables agent sleep through the experimental switch', async () => {
    const updateSettings = vi.fn()
    const { root, container } = await renderExperimentalPane({ updateSettings })

    const switchButton = container.querySelector<HTMLButtonElement>(
      '#experimental-agent-hibernation button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('Agent sleep switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalAgentHibernation: true })
    root.unmount()
  })

  it('renders context pressure as an off-by-default searchable switch without sub-controls', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={settings} updateSettings={vi.fn()} />
    )

    expect(settings.experimentalContextPressure).toBe(false)
    expect(markup).toContain('Context pressure')
    expect(markup).not.toContain('Warn at')
    expect(markup).not.toContain('Soft limits')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).toContain(
      'Context pressure'
    )
    // Why: getExperimentalSearchEntry() throws on a missing/renamed catalog title.
    expect(getExperimentalSearchEntry().contextPressure.targetSectionId).toBe(
      'experimental-context-pressure'
    )
  })

  it('enables context pressure through the experimental switch', async () => {
    const updateSettings = vi.fn()
    const { root, container } = await renderExperimentalPane({ updateSettings })

    const switchButton = container.querySelector<HTMLButtonElement>(
      '#experimental-context-pressure button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('Context pressure switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalContextPressure: true })
    root.unmount()
  })

  it('updates warn and critical percent thresholds through their number fields', async () => {
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalContextPressure: true
    }
    const { root, container } = await renderExperimentalPane({ updateSettings, settings })

    const [warnInput, criticalInput] = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        '#experimental-context-pressure input[type="number"]'
      )
    )
    if (!warnInput || !criticalInput) {
      throw new Error('Context pressure threshold inputs were not rendered')
    }
    expect(warnInput.value).toBe('70')
    expect(criticalInput.value).toBe('90')
    expect(warnInput.min).toBe('1')
    expect(warnInput.max).toBe('100')

    await act(async () => {
      setInputValue(warnInput, '75')
    })
    await act(async () => {
      warnInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ contextPressureWarnPercent: 75 })

    await act(async () => {
      setInputValue(criticalInput, '95')
    })
    await act(async () => {
      criticalInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ contextPressureCriticalPercent: 95 })

    // Why: dropping critical below warn must drag warn down so the pair stays ordered.
    await act(async () => {
      setInputValue(criticalInput, '50')
    })
    await act(async () => {
      criticalInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({
      contextPressureCriticalPercent: 50,
      contextPressureWarnPercent: 50
    })
    root.unmount()
  })

  it('adds and removes soft-limit rows persisting a sanitized record', async () => {
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalContextPressure: true,
      contextPressureSoftLimits: { codex: 100_000 }
    }
    const { root, container } = await renderExperimentalPane({ updateSettings, settings })
    const section = container.querySelector('#experimental-context-pressure')
    if (!section) {
      throw new Error('Context pressure section was not rendered')
    }

    const addLimitButton = Array.from(section.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Add limit'
    )
    if (!addLimitButton) {
      throw new Error('Add limit button was not rendered')
    }
    await act(async () => {
      addLimitButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const draftKeyInput = section.querySelector<HTMLInputElement>(
      'input[placeholder="global, provider:id, model:id, or agent:type"]'
    )
    const draftTokensInput = section.querySelector<HTMLInputElement>('input[placeholder="Tokens"]')
    const confirmAddButton = Array.from(section.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )
    if (!draftKeyInput || !draftTokensInput || !confirmAddButton) {
      throw new Error('Soft-limit draft row was not rendered')
    }

    await act(async () => {
      setInputValue(draftKeyInput, ' CODEX ')
      setInputValue(draftTokensInput, '200000')
    })
    expect(confirmAddButton.disabled).toBe(true)
    expect(section.querySelector('[role="alert"]')?.textContent).toContain('already exists')

    // Why: incomplete/invalid drafts must stay unpersistable.
    expect(confirmAddButton.disabled).toBe(true)
    await act(async () => {
      setInputValue(draftKeyInput, '  claude-opus-5  ')
    })
    await act(async () => {
      setInputValue(draftTokensInput, '400000.5')
    })
    expect(confirmAddButton.disabled).toBe(true)

    await act(async () => {
      setInputValue(draftTokensInput, '400000')
    })
    expect(confirmAddButton.disabled).toBe(false)
    await act(async () => {
      confirmAddButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({
      contextPressureSoftLimits: { codex: 100_000, 'claude-opus-5': 400_000 }
    })

    const removeButton = section.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove soft limit for codex"]'
    )
    if (!removeButton) {
      throw new Error('Soft-limit remove button was not rendered')
    }
    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ contextPressureSoftLimits: {} })
    root.unmount()
  })

  it('reverts an existing soft-limit row when its key collides', async () => {
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalContextPressure: true,
      contextPressureSoftLimits: { codex: 100_000, 'model:claude-opus-5': 200_000 }
    }
    const { root, container } = await renderExperimentalPane({ updateSettings, settings })
    const keyInput = Array.from(container.querySelectorAll<HTMLInputElement>('input')).find(
      (input) => input.value === 'model:claude-opus-5'
    )
    if (!keyInput) {
      throw new Error('Existing soft-limit row was not rendered')
    }

    await act(async () => {
      setInputValue(keyInput, ' CODEX ')
      keyInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    expect(keyInput.value).toBe('model:claude-opus-5')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already exists')
    root.unmount()
  })

  it('enables new card style through the experimental switch', async () => {
    const updateSettings = vi.fn()
    const { root, container } = await renderExperimentalPane({ updateSettings })

    const switchButton = container.querySelector<HTMLButtonElement>(
      '#experimental-new-worktree-card-style button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('New card style switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalNewWorktreeCardStyle: true })
    root.unmount()
  })
})
