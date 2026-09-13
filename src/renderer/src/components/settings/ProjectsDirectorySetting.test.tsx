// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ProjectsDirectorySetting } from './ProjectsDirectorySetting'

let container: HTMLDivElement
let root: Root
let pickFolderMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  pickFolderMock = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { repos: { pickFolder: pickFolderMock } }
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

function renderSetting(args: {
  settings?: Partial<GlobalSettings>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): void {
  act(() => {
    root.render(
      <ProjectsDirectorySetting
        settings={{ ...getDefaultSettings('/tmp'), ...args.settings }}
        updateSettings={args.updateSettings}
      />
    )
  })
}

function getInput(): HTMLInputElement {
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('projects directory input was not rendered')
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

function pressInputKey(key: string, options?: { isComposing?: boolean }): void {
  act(() => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true })
    if (options?.isComposing !== undefined) {
      Object.defineProperty(event, 'isComposing', { value: options.isComposing })
    }
    getInput().dispatchEvent(event)
  })
}

async function clickBrowseAfterInputBlur(): Promise<void> {
  await act(async () => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (entry) => entry.textContent?.trim() === 'Browse'
    )
    if (!button) {
      throw new Error('browse button was not rendered')
    }
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    getInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ProjectsDirectorySetting', () => {
  it('renders empty when the setting was never set', () => {
    renderSetting({ updateSettings: vi.fn() })
    expect(getInput().value).toBe('')
  })

  it('keeps typed paths local until blur, then saves the trimmed value', () => {
    const updateSettings = vi.fn()
    renderSetting({ updateSettings })

    typePath('/Users/alice/d')
    typePath('/Users/alice/dev ')
    expect(updateSettings).not.toHaveBeenCalled()

    blurInput()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ projectsDir: '/Users/alice/dev' })
  })

  it('commits Enter once even though Enter also blurs the input', () => {
    const updateSettings = vi.fn()
    renderSetting({ updateSettings })

    typePath('/Users/alice/dev')
    pressInputKey('Enter')
    blurInput()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ projectsDir: '/Users/alice/dev' })
  })

  it('does not commit Enter while IME composition is active', () => {
    const updateSettings = vi.fn()
    renderSetting({ updateSettings })

    typePath('/Users/alice/dev')
    pressInputKey('Enter', { isComposing: true })

    expect(getInput().value).toBe('/Users/alice/dev')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('resets the draft on Escape without saving', () => {
    const updateSettings = vi.fn()
    renderSetting({ settings: { projectsDir: '/Users/alice/dev' }, updateSettings })

    typePath('/Users/alice/other')
    pressInputKey('Escape')
    blurInput()

    expect(getInput().value).toBe('/Users/alice/dev')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('clearing the field saves an empty string so the resolver falls back', () => {
    const updateSettings = vi.fn()
    renderSetting({ settings: { projectsDir: '/Users/alice/dev' }, updateSettings })

    typePath('')
    blurInput()

    expect(updateSettings).toHaveBeenCalledWith({ projectsDir: '' })
  })

  it('does not save a dirty partial path before Browse resolves', async () => {
    const updateSettings = vi.fn()
    pickFolderMock.mockResolvedValue('/Users/alice/dev')
    renderSetting({ updateSettings })

    typePath('/Users/al')
    await clickBrowseAfterInputBlur()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ projectsDir: '/Users/alice/dev' })
  })

  it('resets an unsaved dirty draft when Browse is canceled', async () => {
    const updateSettings = vi.fn()
    pickFolderMock.mockResolvedValue(null)
    renderSetting({ settings: { projectsDir: '/Users/alice/dev' }, updateSettings })

    typePath('/Users/al')
    await clickBrowseAfterInputBlur()

    expect(getInput().value).toBe('/Users/alice/dev')
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
