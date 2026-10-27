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

describe('AdvancedNetworkSettingsSection Node.js download mirror', () => {
  it('shows a saved mirror and commits a normalized new one on blur', () => {
    const updateSettings = vi.fn()
    const { container } = render(
      <AdvancedNetworkSettingsSection
        settings={{ ...getDefaultSettings('/tmp'), nodeDistMirrorUrl: 'https://old.example/dist' }}
        updateSettings={updateSettings}
      />
    )
    const input = container.querySelector<HTMLInputElement>('#settings-node-dist-mirror-url')!
    expect(input.value).toBe('https://old.example/dist')

    fireEvent.change(input, { target: { value: ' https://npmmirror.com/mirrors/node/ ' } })
    fireEvent.blur(input)

    expect(updateSettings).toHaveBeenCalledWith({
      nodeDistMirrorUrl: 'https://npmmirror.com/mirrors/node'
    })
  })

  it('keeps an invalid mirror out of settings and says why', () => {
    const updateSettings = vi.fn()
    const { container } = render(
      <AdvancedNetworkSettingsSection
        settings={{ ...getDefaultSettings('/tmp'), nodeDistMirrorUrl: 'https://old.example/dist' }}
        updateSettings={updateSettings}
      />
    )
    const input = container.querySelector<HTMLInputElement>('#settings-node-dist-mirror-url')!

    fireEvent.change(input, { target: { value: 'https://user:pw@mirror.example/dist' } })
    fireEvent.blur(input)

    expect(updateSettings).not.toHaveBeenCalled()
    expect(container.textContent).toContain('cannot contain a user name or password')
  })

  it('follows settings reloads A to B and back to A', () => {
    const updateSettings = vi.fn()
    const base = getDefaultSettings('/tmp')
    const a = 'https://a.example/dist'
    const b = 'https://b.example/dist'
    const view = (mirror: string) => (
      <AdvancedNetworkSettingsSection
        settings={{ ...base, nodeDistMirrorUrl: mirror }}
        updateSettings={updateSettings}
      />
    )
    const { container, rerender } = render(view(a))
    const input = () => container.querySelector<HTMLInputElement>('#settings-node-dist-mirror-url')!

    fireEvent.change(input(), { target: { value: b } })
    fireEvent.blur(input())
    rerender(view(b))
    rerender(view(a))

    expect(input().value).toBe(a)
    fireEvent.blur(input())
    expect(updateSettings).toHaveBeenCalledTimes(1)
  })
})
