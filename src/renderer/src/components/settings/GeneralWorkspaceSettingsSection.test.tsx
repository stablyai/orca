// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { GeneralWorkspaceSettingsSection } from './GeneralWorkspaceSettingsSection'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

// Why: these siblings pull in window.api / host-scope hooks that aren't relevant
// to the folder-name-template control under test; stub them to keep the render
// focused and deterministic.
vi.mock('./WorkspaceDirectorySetting', () => ({
  WorkspaceDirectorySetting: () => null
}))
vi.mock('./OpenInMenuSetting', () => ({
  OpenInMenuSetting: () => null
}))

const SETTINGS = {
  worktreeFolderNameTemplate: '',
  nestWorkspaces: true,
  skipDeleteWorktreeConfirm: false,
  skipDeleteAutomationConfirm: false,
  openInApplications: []
} as unknown as GlobalSettings

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

function render(
  settings: GlobalSettings,
  updateSettings: (updates: Partial<GlobalSettings>) => void
): void {
  act(() => {
    root.render(React.createElement(GeneralWorkspaceSettingsSection, { settings, updateSettings }))
  })
}

function getTemplateInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[placeholder="%projectName%_%workspaceName%"]'
  )
  if (!input) {
    throw new Error('folder name template input not found')
  }
  return input
}

function setNativeValue(input: HTMLInputElement, text: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, text)
}

describe('GeneralWorkspaceSettingsSection — folder name template', () => {
  it('renders a visible label, description, and token hint for the template control', () => {
    render(SETTINGS, vi.fn())

    // Why: SearchableSetting only uses title/description for search matching, so
    // the visible label/description must be rendered explicitly (regression: the
    // control previously rendered as an unlabeled bare input).
    const text = container.textContent ?? ''
    expect(text).toContain('Workspace Folder Name Template')
    expect(text).toContain('Sets the on-disk workspace folder name with tokens')
    expect(text).toContain('%projectName%')
    expect(text).toContain('%shortId%')
  })

  it('associates the visible label with the input via htmlFor/id', () => {
    render(SETTINGS, vi.fn())

    const input = getTemplateInput()
    const label = container.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)
    expect(input.id).toBeTruthy()
    expect(label?.textContent).toContain('Workspace Folder Name Template')
  })

  it('updates the setting as the user edits the template', () => {
    const updateSettings = vi.fn()
    render(SETTINGS, updateSettings)

    const input = getTemplateInput()
    act(() => {
      setNativeValue(input, '%projectName%_%workspaceName%')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({
      worktreeFolderNameTemplate: '%projectName%_%workspaceName%'
    })
  })
})
