// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { GitLabUrlSetting } from './GitLabUrlSetting'

function typeInto(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

// Why: React routes onBlur through the bubbling focusout event.
function blurField(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

describe('GitLabUrlSetting', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  async function renderSetting(
    gitlabUrl: string,
    updateSettings: (updates: Partial<GlobalSettings>) => void
  ): Promise<HTMLInputElement> {
    const settings: GlobalSettings = { ...getDefaultSettings('/home/test'), gitlabUrl }

    await act(async () => {
      root.render(<GitLabUrlSetting settings={settings} updateSettings={updateSettings} />)
    })

    const input = container.querySelector<HTMLInputElement>('input')
    if (!input) {
      throw new Error('GitLab URL input not found')
    }
    return input
  }

  it('shows the configured URL and single-instance helper copy', async () => {
    const input = await renderSetting('https://gitlab.example.com', () => {})

    expect(input.value).toBe('https://gitlab.example.com')
    expect(input.type).toBe('url')
    expect(container.textContent).toContain('Orca uses this single URL for GitLab operations.')
  })

  it('persists URL edits when the field loses focus, not per keystroke', async () => {
    const updateSettings = vi.fn()
    const input = await renderSetting('', updateSettings)

    await act(async () => {
      typeInto(input, 'https://gitlab.company.test')
    })
    expect(updateSettings).not.toHaveBeenCalled()

    await act(async () => {
      blurField(input)
    })
    expect(updateSettings).toHaveBeenCalledWith({ gitlabUrl: 'https://gitlab.company.test' })
  })

  it('shows the normalized value back and skips the write when nothing changed', async () => {
    const updateSettings = vi.fn()
    const input = await renderSetting('https://gitlab.company.test', updateSettings)

    await act(async () => {
      typeInto(input, 'HTTPS://GitLab.Company.test/group/')
    })
    await act(async () => {
      blurField(input)
    })

    expect(input.value).toBe('https://gitlab.company.test')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('clears a URL it cannot use instead of leaving it looking saved', async () => {
    const updateSettings = vi.fn()
    const input = await renderSetting('', updateSettings)

    await act(async () => {
      typeInto(input, 'gitlab.company.test')
    })
    await act(async () => {
      blurField(input)
    })

    expect(input.value).toBe('')
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
