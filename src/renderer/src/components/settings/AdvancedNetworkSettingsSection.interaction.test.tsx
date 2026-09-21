// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AdvancedNetworkSettingsSection } from './AdvancedNetworkSettingsSection'

afterEach(() => cleanup())

describe('AdvancedNetworkSettingsSection bypass rules control', () => {
  it('keeps newline input and canonicalizes it when focus leaves the textarea', async () => {
    const updateSettings = vi.fn()

    const { container } = render(
      <AdvancedNetworkSettingsSection
        settings={{ ...getDefaultSettings('/tmp'), httpProxyBypassRules: '' }}
        updateSettings={updateSettings}
      />
    )

    const configureButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Configure proxy')
    )
    expect(configureButton).not.toBeUndefined()
    fireEvent.click(configureButton!)

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '#settings-http-proxy-bypass-rules'
    )
    expect(textarea).not.toBeNull()

    fireEvent.change(textarea!, { target: { value: 'localhost\n127.0.0.1\n*.internal.corp' } })
    fireEvent.blur(textarea!)

    expect(updateSettings).toHaveBeenCalledWith({
      httpProxyBypassRules: 'localhost;127.0.0.1;*.internal.corp'
    })
  })

  it('does not commit when Enter is pressed inside the textarea', () => {
    const updateSettings = vi.fn()
    const { container } = render(
      <AdvancedNetworkSettingsSection
        settings={{ ...getDefaultSettings('/tmp'), httpProxyBypassRules: '' }}
        updateSettings={updateSettings}
      />
    )
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Configure proxy')
      )!
    )
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '#settings-http-proxy-bypass-rules'
    )!

    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(document.activeElement).toBe(textarea)
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
