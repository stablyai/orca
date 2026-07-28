// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { GitLabUrlSetting } from './GitLabUrlSetting'

type SettingsWithGitLabUrl = GlobalSettings & { gitlabUrl?: string }

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
    const settings: SettingsWithGitLabUrl = {
      ...getDefaultSettings('/home/test'),
      gitlabUrl
    }

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

  it('persists URL edits when the field loses focus', async () => {
    const updateSettings = vi.fn()
    const input = await renderSetting('', updateSettings)

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, 'https://gitlab.company.test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('blur', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ gitlabUrl: 'https://gitlab.company.test' })
  })
})
