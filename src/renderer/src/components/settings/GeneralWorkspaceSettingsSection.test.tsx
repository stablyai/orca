// @vitest-environment happy-dom

import type React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { GeneralWorkspaceSettingsSection } from './GeneralWorkspaceSettingsSection'

vi.mock('./WorkspaceDirectorySetting', () => ({
  WorkspaceDirectorySetting: () => null
}))

vi.mock('./OpenInMenuSetting', () => ({
  OpenInMenuSetting: () => null
}))

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function renderSection(
  settings: GlobalSettings,
  updateSettings: (updates: Partial<GlobalSettings>) => void
): void {
  act(() => {
    root.render(
      <GeneralWorkspaceSettingsSection settings={settings} updateSettings={updateSettings} />
    )
  })
}

function getAutoCreateTerminalSwitch(): HTMLButtonElement {
  const switchControl = container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Create Terminal on Workspace Selection"]'
  )
  if (!switchControl) {
    throw new Error('auto-create terminal switch was not rendered')
  }
  return switchControl
}

function clickAutoCreateTerminalSwitch(): void {
  act(() => {
    getAutoCreateTerminalSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('GeneralWorkspaceSettingsSection', () => {
  it('treats a missing legacy preference as enabled and lets users disable it', () => {
    const updateSettings = vi.fn()
    renderSection(
      {
        ...getDefaultSettings('/tmp'),
        autoCreateTerminalOnWorkspaceActivation: undefined
      },
      updateSettings
    )

    expect(getAutoCreateTerminalSwitch().getAttribute('aria-checked')).toBe('true')
    clickAutoCreateTerminalSwitch()

    expect(updateSettings).toHaveBeenCalledWith({
      autoCreateTerminalOnWorkspaceActivation: false
    })
  })

  it('lets users re-enable automatic terminal creation', () => {
    const updateSettings = vi.fn()
    renderSection(
      {
        ...getDefaultSettings('/tmp'),
        autoCreateTerminalOnWorkspaceActivation: false
      },
      updateSettings
    )

    expect(getAutoCreateTerminalSwitch().getAttribute('aria-checked')).toBe('false')
    clickAutoCreateTerminalSwitch()

    expect(updateSettings).toHaveBeenCalledWith({
      autoCreateTerminalOnWorkspaceActivation: true
    })
  })
})
