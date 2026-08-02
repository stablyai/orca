// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { WorkspaceDirectorySetting } from './WorkspaceDirectorySetting'

vi.mock('../sidebar/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: [] })
}))

let container: HTMLDivElement
let root: Root
let pickFolderMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  pickFolderMock = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      repos: {
        pickFolder: pickFolderMock
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  Reflect.deleteProperty(window, 'api')
})

function renderWorkspaceDirectorySetting(args: {
  settings?: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): void {
  act(() => {
    root.render(
      <WorkspaceDirectorySetting
        settings={args.settings ?? getDefaultSettings('/tmp')}
        updateSettings={args.updateSettings}
      />
    )
  })
}

function getInput(): HTMLInputElement {
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('workspace directory input was not rendered')
  }
  return input
}

function typePath(path: string): void {
  act(() => {
    const input = getInput()
    // Why: React tracks controlled inputs through the native setter; direct
    // assignment can be ignored by the synthetic input event handler.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, path)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function blurInput(): void {
  act(() => {
    getInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

function pressInputKey(key: string, options?: { isComposing?: boolean; keyCode?: number }): void {
  act(() => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true })
    if (options?.isComposing !== undefined) {
      Object.defineProperty(event, 'isComposing', { value: options.isComposing })
    }
    if (options?.keyCode !== undefined) {
      Object.defineProperty(event, 'keyCode', { value: options.keyCode })
    }
    getInput().dispatchEvent(event)
  })
}

function getBrowseButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (entry) => entry.textContent?.trim() === 'Browse'
  )
  if (!button) {
    throw new Error('browse button was not rendered')
  }
  return button
}

async function clickBrowseAfterInputBlur(): Promise<void> {
  await act(async () => {
    const button = getBrowseButton()
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    getInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('WorkspaceDirectorySetting', () => {
  it('keeps typed workspace paths local until blur', () => {
    const updateSettings = vi.fn()
    renderWorkspaceDirectorySetting({ updateSettings })

    typePath('o')
    typePath('or')
    typePath('orca-workspaces')

    expect(updateSettings).not.toHaveBeenCalled()

    blurInput()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ workspaceDir: 'orca-workspaces' })
  })

  it('commits Enter once even though Enter also blurs the input', () => {
    const updateSettings = vi.fn()
    renderWorkspaceDirectorySetting({ updateSettings })

    typePath('orca-workspaces')
    pressInputKey('Enter')
    blurInput()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ workspaceDir: 'orca-workspaces' })
  })

  it('does not commit Enter while IME composition is active', () => {
    const updateSettings = vi.fn()
    renderWorkspaceDirectorySetting({ updateSettings })

    typePath('orca-workspaces')
    pressInputKey('Enter', { isComposing: true })

    expect(getInput().value).toBe('orca-workspaces')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('resets the draft on Escape without saving', () => {
    const updateSettings = vi.fn()
    renderWorkspaceDirectorySetting({ updateSettings })

    typePath('orca-workspaces')
    pressInputKey('Escape')
    blurInput()

    expect(getInput().value).toBe(getDefaultSettings('/tmp').workspaceDir)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('does not reset Escape while IME composition is active', () => {
    const updateSettings = vi.fn()
    renderWorkspaceDirectorySetting({ updateSettings })

    typePath('orca-workspaces')
    pressInputKey('Escape', { isComposing: true })

    expect(getInput().value).toBe('orca-workspaces')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('does not save a dirty partial path before Browse resolves', async () => {
    const updateSettings = vi.fn()
    pickFolderMock.mockResolvedValue('/Users/alice/workspaces')
    renderWorkspaceDirectorySetting({ updateSettings })

    typePath('orca-w')
    await clickBrowseAfterInputBlur()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ workspaceDir: '/Users/alice/workspaces' })
  })

  it('resets an unsaved dirty draft when Browse is canceled', async () => {
    const updateSettings = vi.fn()
    pickFolderMock.mockResolvedValue(null)
    renderWorkspaceDirectorySetting({ updateSettings })

    typePath('orca-w')
    await clickBrowseAfterInputBlur()

    expect(getInput().value).toBe(getDefaultSettings('/tmp').workspaceDir)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('allows retrying the same draft when the persisted value has not changed', () => {
    const updateSettings = vi.fn()
    renderWorkspaceDirectorySetting({ updateSettings })

    typePath('orca-workspaces')
    blurInput()
    blurInput()

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updateSettings).toHaveBeenNthCalledWith(1, { workspaceDir: 'orca-workspaces' })
    expect(updateSettings).toHaveBeenNthCalledWith(2, { workspaceDir: 'orca-workspaces' })
  })
})
