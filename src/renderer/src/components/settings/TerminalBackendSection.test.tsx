// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { TerminalBackendSection } from './TerminalBackendSection'

describe('TerminalBackendSection', () => {
  it('lets the user select Herdr without changing existing project activations', () => {
    const updateSettings = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <TerminalBackendSection
          settings={getDefaultSettings('/tmp')}
          updateSettings={updateSettings}
        />
      )
    })

    const herdr = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Herdr'
    )
    expect(herdr).toBeTruthy()
    act(() => herdr?.click())
    expect(updateSettings).toHaveBeenCalledWith({ terminalBackendDefault: 'herdr' })

    const system = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'From PATH'
    )
    expect(system).toBeTruthy()
    act(() => system?.click())
    expect(updateSettings).toHaveBeenCalledWith({ herdrBinarySource: { kind: 'system' } })

    act(() => root.unmount())
  })

  it('edits the shared Herdr session name and clears it when blanked', () => {
    const updateSettings = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <TerminalBackendSection
          settings={getDefaultSettings('/tmp')}
          updateSettings={updateSettings}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Shared Herdr session name"]'
    )
    expect(input?.value).toBe('orca')
    act(() => {
      if (!input) {
        return
      }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '  shared-session  '
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ herdrSessionName: '  shared-session  ' })

    act(() => {
      if (!input) {
        return
      }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '')
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ herdrSessionName: '' })

    act(() => root.unmount())
  })

  it('does not offer a built-in Herdr daemon', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <TerminalBackendSection
          settings={{ ...getDefaultSettings('/tmp'), terminalBackendDefault: 'herdr' }}
          updateSettings={vi.fn()}
        />
      )
    })

    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Built-in daemon'
      )
    ).toBe(false)

    act(() => root.unmount())
  })

  it('persists a custom Herdr executable and rejects an empty path on blur', () => {
    const updateSettings = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <TerminalBackendSection
          settings={{
            ...getDefaultSettings('/tmp'),
            herdrBinarySource: { kind: 'custom', path: '/opt/herdr/bin/herdr' }
          }}
          updateSettings={updateSettings}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Custom Herdr executable path"]'
    )
    expect(input?.value).toBe('/opt/herdr/bin/herdr')
    act(() => {
      if (!input) {
        return
      }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '/srv/herdr'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({
      herdrBinarySource: { kind: 'custom', path: '/srv/herdr' }
    })

    act(() => {
      if (!input) {
        return
      }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '')
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ herdrBinarySource: { kind: 'system' } })

    act(() => root.unmount())
  })
})
